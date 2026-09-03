-- GAL CRM V1 — referral model ("מי הפנתה אותה")
--
-- Adds public.referrals: an explicit, normalized relationship
-- recording that a Contact was referred by an existing Customer.
-- Deliberately NOT encoded as free text, and deliberately NOT modeled
-- via the existing touchpoints table (touchpoints.lead_id is NOT NULL
-- — every touchpoint belongs to a Lead — but a referral must be
-- capturable for a directly-created Customer who has, by design,
-- no Lead at all; loosening touchpoints.lead_id to support a
-- lead-less "Contact touchpoint" was inspected and rejected as a
-- broader, riskier schema change than this narrower, purpose-built
-- table, with no benefit — referrals already needs its own shape
-- (a referrer, not just a channel) that touchpoints doesn't have).
--
-- Design:
--   referred_contact_id uuid not null unique -> at most one referrer
--     per referred Contact, enforced by the database itself (this
--     UNIQUE constraint is also exactly what makes a second referral
--     insert for an already-referred contact fail loudly rather than
--     silently overwrite — see the application-layer ON CONFLICT DO
--     NOTHING callers use instead of forcing an error for that
--     specific, benign, idempotent case).
--   referrer_customer_id uuid, NULLABLE, ON DELETE SET NULL -> the
--     referrer is optional (an unknown/historical referral can still
--     be recorded as "she was referred, by someone unrecorded"), and
--     if the referrer's own Customer row is ever removed, the fact
--     that this Contact came via referral is preserved — only WHO
--     referred her is forgotten, which is the right behavior ("deleting
--     ordinary lead state should not accidentally destroy valid
--     referral history").
--   ON DELETE CASCADE on referred_contact_id: if the referred Contact
--     itself is later deleted (e.g. an orphaned test lead's Contact,
--     via delete_lead_safely — see the note below), there is no
--     remaining subject for this row to describe, so it is correctly
--     removed with it.
--
-- Interaction with delete_lead_safely — NO CHANGE NEEDED to that
-- function, verified by reasoning through every case:
--   - referrals never references lead_id at all (only contact_id /
--     customer_id), so deleting a LEAD never directly touches it.
--   - If the lead's Contact survives the deletion (shared with another
--     lead, or already a Customer), the referral row — which
--     references the CONTACT, not the lead — is completely untouched.
--     This is exactly "referral belongs to the person/Contact
--     relationship, not merely one Lead", satisfied automatically.
--   - If the Contact is orphan-deleted by delete_lead_safely, the new
--     ON DELETE CASCADE above removes any referral row about that
--     Contact along with it — correct, since the referred person no
--     longer exists in the CRM at all.
--   - A referrer's own Customer row can never be the one deleted by
--     delete_lead_safely in the first place: that function's very
--     first check already BLOCKS deleting any lead whose contact has
--     a Customer row — a referrer, by definition, has one.
--
-- Self-referral is prevented by a trigger (not a CHECK constraint —
-- Postgres CHECK constraints cannot contain subqueries, and
-- determining "is the referrer the same person" requires looking up
-- referrer_customer_id's own contact_id). Mirrors this schema's
-- existing precedent for a similar cross-row rule
-- (prevent_payment_fact_changes, a plain SECURITY INVOKER trigger with
-- no explicit search_path — same choice here, for the same reason: an
-- ordinary trigger function running with the caller's own privileges
-- has no privilege-escalation surface, unlike a SECURITY DEFINER
-- function, so pinning search_path isn't needed for safety here).

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  referred_contact_id uuid not null unique references public.contacts(id) on delete cascade,
  referrer_customer_id uuid references public.customers(id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);

comment on table public.referrals is
  'Explicit "this Contact was referred by this Customer" relationship. '
  'referred_contact_id is UNIQUE — at most one referrer per Contact, '
  'enforced by the database. referrer_customer_id is nullable (an '
  'unknown/historical referral is still recordable) and ON DELETE SET '
  'NULL (removing the referrer''s Customer row never destroys the fact '
  'that this Contact came via referral).';

create index referrals_referrer_customer_id_idx
  on public.referrals (referrer_customer_id)
  where referrer_customer_id is not null;

create or replace function public.prevent_self_referral()
returns trigger
language plpgsql
as $$
declare
  v_referrer_contact_id uuid;
begin
  if new.referrer_customer_id is not null then
    select contact_id into v_referrer_contact_id
    from public.customers
    where id = new.referrer_customer_id;

    if v_referrer_contact_id is not null and v_referrer_contact_id = new.referred_contact_id then
      raise exception 'A contact cannot refer themselves' using errcode = 'GALR1';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.prevent_self_referral() is
  'Blocks a referrals row where the referrer''s own contact_id equals '
  'the referred_contact_id — a person cannot refer themselves. Cannot '
  'be a CHECK constraint (requires a subquery to resolve '
  'referrer_customer_id -> its contact_id).';

create trigger prevent_self_referral
  before insert or update on public.referrals
  for each row execute function public.prevent_self_referral();

-- ============================================================
-- Row Level Security — same shape as touchpoints (a correctable
-- attribution relationship, not an immutable audit log): full CRUD for
-- authorized active CRM users.
-- ============================================================

alter table public.referrals enable row level security;

create policy referrals_crm_select
  on public.referrals for select
  to authenticated
  using (public.is_crm_user());

create policy referrals_crm_insert
  on public.referrals for insert
  to authenticated
  with check (public.is_crm_user());

create policy referrals_crm_update
  on public.referrals for update
  to authenticated
  using (public.is_crm_user())
  with check (public.is_crm_user());

create policy referrals_crm_delete
  on public.referrals for delete
  to authenticated
  using (public.is_crm_user());

grant select, insert, update, delete on public.referrals to authenticated;
