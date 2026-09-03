-- GAL CRM V1 — safe, atomic lead deletion
--
-- Adds public.delete_lead_safely(uuid), a single transactional RPC that
-- permanently deletes an ordinary (never-converted) lead and its
-- lead-specific operational records, and — only when nothing else
-- legitimately references it — the underlying Contact too. Financial/
-- business history (a Customer record, purchases, payments) can NEVER
-- be destroyed through this operation; if any exists, the whole call
-- is blocked and nothing is deleted.
--
-- Why SECURITY DEFINER (not INVOKER, unlike change_lead_stage /
-- convert_lead_to_won): confirmed live against this project's actual
-- RLS policies (pg_policies) before writing this migration —
-- lead_stage_events has SELECT and INSERT policies for `authenticated`
-- only, deliberately no UPDATE/DELETE policy at all (see
-- 20260902083853_gal_crm_v1_authorization_rls.sql's own comment: audit
-- history "must not be rewritable, even by an otherwise fully-
-- authorized CRM user"). A normal SECURITY INVOKER call cleaning up a
-- lead's stage-event history would therefore always be blocked by RLS
-- for every authenticated user, with no exception. Deleting that
-- history is legitimate ONLY as an inseparable part of this specific,
-- safety-gated, all-or-nothing "delete this whole lead" operation —
-- exactly the kind of narrow, audited escalation SECURITY DEFINER
-- exists for (the same rationale already used by public.is_crm_user()
-- to read app_users, which `authenticated` also cannot SELECT
-- directly). Because DEFINER bypasses RLS entirely for its own
-- statements, this function performs its OWN explicit authorization
-- check (public.is_crm_user()) before doing anything else, rather than
-- relying on table-level RLS to gate access the way every other
-- authenticated code path in this schema does.
--
-- Every foreign key this function's behavior depends on was verified
-- live (information_schema.referential_constraints) immediately before
-- writing this migration, not assumed from memory:
--   leads.contact_id        -> contacts   ON DELETE CASCADE
--   customers.contact_id    -> contacts   ON DELETE RESTRICT
--   meta_lead_ingestions.contact_id    -> contacts   ON DELETE SET NULL
--   lead_stage_events.lead_id -> leads   ON DELETE CASCADE
--   touchpoints.lead_id     -> leads     ON DELETE CASCADE
--   follow_up_tasks.lead_id -> leads     ON DELETE CASCADE
--   purchases.lead_id       -> leads     ON DELETE SET NULL
--   meta_lead_ingestions.lead_id       -> leads     ON DELETE SET NULL
--   meta_lead_ingestions.touchpoint_id -> touchpoints ON DELETE SET NULL
--   purchases.customer_id   -> customers ON DELETE RESTRICT
--   payments.purchase_id    -> purchases ON DELETE RESTRICT
--
-- This function does NOT rely on any of the above cascading implicitly
-- — every lead-specific table is deleted from explicitly, in dependency
-- order, so the operation is self-documenting and independent of
-- future schema changes to those ON DELETE clauses. meta_lead_ingestions
-- is the one deliberate exception: it is NEVER deleted here (it is a
-- durable ingestion audit trail — see its own migration) and needs no
-- explicit statement at all, because its lead_id/touchpoint_id/
-- contact_id columns are already ON DELETE SET NULL — the rows this
-- function does delete cause Postgres to null those columns out
-- automatically, preserving the ingestion history row itself intact.
--
-- Blocking rule: refuses to delete when EITHER a customers row exists
-- for the lead's contact_id, OR a purchases row references this lead
-- directly (purchases.lead_id) — either is real financial/business
-- history. The purchases check is deliberately kept even though, by
-- this app's actual code paths, a purchase can only ever come from
-- convert_lead_to_won (which always creates the customer first), so
-- the customers check alone should already be sufficient — the
-- purchases check is defense-in-depth against any future code path
-- that creates a purchase without going through that function.
-- payments are not checked directly: payments.purchase_id is ON DELETE
-- RESTRICT, and a purchase is already blocking, so a payment can never
-- be reached by this function in the first place.
--
-- Blocked calls raise a distinct SQLSTATE ('GALB1') rather than relying
-- on message-text matching, so the calling Server Action can show a
-- specific, reassuring Hebrew explanation instead of a generic failure.

create or replace function public.delete_lead_safely(p_lead_id uuid)
returns table (contact_deleted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact_id uuid;
  v_customer_exists boolean;
  v_purchase_exists boolean;
  v_other_leads_count integer;
  v_contact_deleted boolean := false;
begin
  if not public.is_crm_user() then
    raise exception 'Not authorized to delete leads';
  end if;

  select contact_id into v_contact_id
  from public.leads
  where id = p_lead_id
  for update;

  if not found then
    raise exception 'Lead not found or not accessible';
  end if;

  select exists(
    select 1 from public.customers where contact_id = v_contact_id
  ) into v_customer_exists;

  select exists(
    select 1 from public.purchases where lead_id = p_lead_id
  ) into v_purchase_exists;

  if v_customer_exists or v_purchase_exists then
    raise exception 'Cannot delete this lead: the associated contact has customer/purchase history that must be preserved.'
      using errcode = 'GALB1';
  end if;

  -- Explicit, ordered cleanup of lead-specific operational records
  -- (see the "does NOT rely on cascade" note above).
  delete from public.lead_stage_events where lead_id = p_lead_id;
  delete from public.touchpoints where lead_id = p_lead_id;
  delete from public.follow_up_tasks where lead_id = p_lead_id;
  delete from public.leads where id = p_lead_id;

  -- Orphan check: the Contact is deleted only when NOTHING legitimate
  -- still references it. meta_lead_ingestions is deliberately not
  -- considered a blocking reference here — it is an audit trail whose
  -- contact_id is designed to safely go NULL (ON DELETE SET NULL) when
  -- the contact it once pointed to is removed; that is the intended
  -- behavior, not data loss.
  select count(*) into v_other_leads_count
  from public.leads
  where contact_id = v_contact_id;

  if v_other_leads_count = 0 then
    delete from public.contacts
    where id = v_contact_id
      and not exists (select 1 from public.leads where contact_id = v_contact_id)
      and not exists (select 1 from public.customers where contact_id = v_contact_id);
    if found then
      v_contact_deleted := true;
    end if;
  end if;

  return query select v_contact_deleted;
end;
$$;

comment on function public.delete_lead_safely(uuid) is
  'Atomically deletes an ordinary (never-converted) lead and its '
  'lead-specific operational records (stage events, touchpoints, '
  'follow-ups), then deletes the underlying Contact only if nothing '
  'else legitimately references it. Blocks entirely (SQLSTATE GALB1, '
  'no partial deletion) if the contact has a Customer record or any '
  'purchase history — financial/business history can never be '
  'destroyed through this function. meta_lead_ingestions rows are '
  'never deleted; their lead_id/touchpoint_id/contact_id columns are '
  'already ON DELETE SET NULL, preserving ingestion audit history. '
  'SECURITY DEFINER: performs its own public.is_crm_user() check '
  '(required specifically to clean up lead_stage_events, which '
  '`authenticated` has no DELETE policy for by design — see this '
  'migration''s own comments).';

revoke all on function public.delete_lead_safely(uuid) from public;
grant execute on function public.delete_lead_safely(uuid) to authenticated;
