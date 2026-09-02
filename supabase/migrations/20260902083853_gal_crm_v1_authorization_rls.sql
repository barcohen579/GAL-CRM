-- GAL CRM V1 — authorization / RLS policies
--
-- Depends on: 20260902072131_gal_crm_v1_core_schema.sql (all tables already
-- have ROW LEVEL SECURITY enabled with zero policies — i.e. currently
-- inaccessible to anon/authenticated, accessible only to service_role /
-- the table owner). This migration adds the actual access policies.
--
-- No personal data (no emails, phone numbers, passwords, or Gal's/Bar's
-- auth.users UUID) is embedded anywhere in this file. The very first
-- public.app_users row still has to be created manually after this
-- migration is applied — see the bootstrap note at the end of this file.
--
-- Authorization model:
--   An authenticated Supabase user may access CRM data ONLY if there is a
--   matching row in public.app_users where auth_user_id = auth.uid() AND
--   is_active = true. Being a Supabase Auth user is NOT sufficient on its
--   own — CRM access is an explicit, separately-granted membership.
--
-- Scope excluded from this migration (unchanged from the core schema):
--   - Meta Ads / campaign / daily-metric tables
--   - Notification-provider / reminder-delivery tables
--   - AI SuggestedMessage table
--   - No anon policies anywhere, on any table.

-- ============================================================
-- public.is_crm_user()
--
-- SECURITY DEFINER is required here: a normal `authenticated` caller has
-- no SELECT access to public.app_users under RLS (see app_users policies
-- below — there is deliberately no policy letting a user read arbitrary
-- rows of that table beyond what's granted). This function runs with the
-- privileges of its owner (the migration role, which is exempt from RLS
-- as the table owner) specifically so it CAN check membership, while
-- still only ever returning a boolean to the caller — it never returns
-- row data, so it cannot be used to exfiltrate other users' information.
--
-- Security-hardening applied:
--   - `set search_path = ''` pins name resolution so a caller cannot
--     hijack this function's behavior by manipulating their session's
--     search_path (the classic SECURITY DEFINER privilege-escalation
--     vector). Every identifier below is fully schema-qualified
--     (public.app_users, auth.uid()) so this is safe — pg_catalog is
--     always implicitly searched regardless of search_path, so built-in
--     operators and types still resolve correctly.
--   - `stable`, not `volatile`: it only reads data and does not modify
--     anything, and its result is consistent within one query/statement.
--   - EXECUTE is revoked from PUBLIC and re-granted only to
--     `authenticated` below — `anon` has no reason to ever call it
--     (an unauthenticated caller has no auth.uid() and could never match
--     a row anyway, but least-privilege is cheap here).
-- ============================================================

create or replace function public.is_crm_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_users
    where auth_user_id = auth.uid()
      and is_active
  );
$$;

comment on function public.is_crm_user() is
  'Returns true iff the calling authenticated user has an active public.app_users '
  'row. SECURITY DEFINER so it can check membership under RLS; returns only a '
  'boolean, never row data. Used as the gate in every CRM table policy below.';

revoke all on function public.is_crm_user() from public;
grant execute on function public.is_crm_user() to authenticated;

-- ============================================================
-- app_users
--
-- Authorized CRM users may SELECT app_users (needed for UI purposes such
-- as "assigned to" pickers). There is deliberately NO insert/update/delete
-- policy for the authenticated role at all:
--   - no self-enrollment (no INSERT policy)
--   - no self-activation / self-deactivation / self-editing of any kind,
--     including their own row (no UPDATE policy — this table has no
--     "edit my own profile" carve-out in V1)
--   - no ability to remove any user, including themselves (no DELETE
--     policy)
-- Granting, activating, or revoking CRM access remains a trusted
-- admin/backend operation performed via service_role or direct SQL —
-- never through normal authenticated CRM access.
-- ============================================================

create policy app_users_crm_select
  on public.app_users
  for select
  using (public.is_crm_user());

-- ============================================================
-- contacts — full CRUD for authorized active CRM users.
-- ============================================================

create policy contacts_crm_select
  on public.contacts for select
  using (public.is_crm_user());

create policy contacts_crm_insert
  on public.contacts for insert
  with check (public.is_crm_user());

create policy contacts_crm_update
  on public.contacts for update
  using (public.is_crm_user())
  with check (public.is_crm_user());

create policy contacts_crm_delete
  on public.contacts for delete
  using (public.is_crm_user());

-- ============================================================
-- leads — full CRUD for authorized active CRM users.
-- (Deleting a lead never destroys revenue history: purchases.lead_id is
-- ON DELETE SET NULL at the schema level.)
-- ============================================================

create policy leads_crm_select
  on public.leads for select
  using (public.is_crm_user());

create policy leads_crm_insert
  on public.leads for insert
  with check (public.is_crm_user());

create policy leads_crm_update
  on public.leads for update
  using (public.is_crm_user())
  with check (public.is_crm_user());

create policy leads_crm_delete
  on public.leads for delete
  using (public.is_crm_user());

-- ============================================================
-- lead_stage_events — append-only audit trail. Stricter than the default:
-- SELECT + INSERT only. No UPDATE or DELETE policy for any authenticated
-- user, ever — pipeline history must not be rewritable, even by an
-- otherwise fully-authorized CRM user.
-- ============================================================

create policy lead_stage_events_crm_select
  on public.lead_stage_events for select
  using (public.is_crm_user());

create policy lead_stage_events_crm_insert
  on public.lead_stage_events for insert
  with check (public.is_crm_user());

-- ============================================================
-- touchpoints — full CRUD for authorized active CRM users. Attribution
-- corrections (fixing a mistagged channel, removing an erroneous entry)
-- are legitimate normal operations, unlike financial or stage-history
-- records, so no stricter rule applies here.
-- ============================================================

create policy touchpoints_crm_select
  on public.touchpoints for select
  using (public.is_crm_user());

create policy touchpoints_crm_insert
  on public.touchpoints for insert
  with check (public.is_crm_user());

create policy touchpoints_crm_update
  on public.touchpoints for update
  using (public.is_crm_user())
  with check (public.is_crm_user());

create policy touchpoints_crm_delete
  on public.touchpoints for delete
  using (public.is_crm_user());

-- ============================================================
-- follow_up_tasks — full CRUD for authorized active CRM users.
-- ============================================================

create policy follow_up_tasks_crm_select
  on public.follow_up_tasks for select
  using (public.is_crm_user());

create policy follow_up_tasks_crm_insert
  on public.follow_up_tasks for insert
  with check (public.is_crm_user());

create policy follow_up_tasks_crm_update
  on public.follow_up_tasks for update
  using (public.is_crm_user())
  with check (public.is_crm_user());

create policy follow_up_tasks_crm_delete
  on public.follow_up_tasks for delete
  using (public.is_crm_user());

-- ============================================================
-- customers — full CRUD for authorized active CRM users. A customer with
-- real purchase history cannot actually be deleted regardless of this
-- policy: purchases.customer_id is ON DELETE RESTRICT at the schema
-- level, so this policy only ever allows removing a customer row that
-- has no purchases attached (e.g. a data-entry mistake).
-- ============================================================

create policy customers_crm_select
  on public.customers for select
  using (public.is_crm_user());

create policy customers_crm_insert
  on public.customers for insert
  with check (public.is_crm_user());

create policy customers_crm_update
  on public.customers for update
  using (public.is_crm_user())
  with check (public.is_crm_user());

create policy customers_crm_delete
  on public.customers for delete
  using (public.is_crm_user());

-- ============================================================
-- purchases — full CRUD for authorized active CRM users. As with
-- customers, real financial history is protected at the schema level:
-- payments.purchase_id is ON DELETE RESTRICT, so a purchase with any
-- payment recorded against it cannot be deleted through this policy
-- either — only a purchase with zero payments can actually be removed.
-- ============================================================

create policy purchases_crm_select
  on public.purchases for select
  using (public.is_crm_user());

create policy purchases_crm_insert
  on public.purchases for insert
  with check (public.is_crm_user());

create policy purchases_crm_update
  on public.purchases for update
  using (public.is_crm_user())
  with check (public.is_crm_user());

create policy purchases_crm_delete
  on public.purchases for delete
  using (public.is_crm_user());

-- ============================================================
-- payments — the strictest table. SELECT, INSERT, and a deliberately
-- RESTRICTED UPDATE for authorized active CRM users. NO DELETE policy at
-- all: financial history cannot be deleted through normal authenticated
-- CRM access, full stop.
--
-- On UPDATE: RLS alone cannot restrict which *columns* change within a
-- row it already allows a user to update — USING/WITH CHECK reason about
-- whole-row visibility and validity, not old-vs-new column diffs. An
-- unrestricted UPDATE policy would let an authorized user silently
-- rewrite the recorded amount, currency, purchase link, payment date, or
-- method after the fact, which would undermine the append-only ledger
-- guarantee just as much as a DELETE would.
--
-- Smallest practical V1 fix: the RLS UPDATE policy grants row access as
-- usual, but a BEFORE UPDATE trigger (prevent_payment_fact_changes,
-- defined below) independently blocks any change to the financial facts
-- of a payment (purchase_id, amount, currency, paid_at, method,
-- created_at). Only `status` (e.g. PAID -> REFUNDED) and `notes` may
-- change. This trigger applies to every role, including service_role —
-- a deliberate choice, since exempting service_role would reopen the
-- exact loophole this exists to close. A genuine administrative
-- correction remains possible via an explicit, auditable
-- ALTER TABLE ... DISABLE TRIGGER step, never silently.
-- ============================================================

create or replace function public.prevent_payment_fact_changes()
returns trigger
language plpgsql
as $$
begin
  if new.purchase_id is distinct from old.purchase_id
     or new.amount is distinct from old.amount
     or new.currency is distinct from old.currency
     or new.paid_at is distinct from old.paid_at
     or new.method is distinct from old.method
     or new.created_at is distinct from old.created_at
  then
    raise exception
      'payments: purchase_id, amount, currency, paid_at, method and created_at '
      'cannot be modified after creation — only status and notes may change';
  end if;
  return new;
end;
$$;

comment on function public.prevent_payment_fact_changes() is
  'Guards payments append-only integrity at the column level: once written, '
  'only status and notes may change. Applies to every role (no service_role '
  'exemption) so no normal code path can rewrite recorded financial facts.';

create trigger prevent_payment_fact_changes
  before update on public.payments
  for each row execute function public.prevent_payment_fact_changes();

create policy payments_crm_select
  on public.payments for select
  using (public.is_crm_user());

create policy payments_crm_insert
  on public.payments for insert
  with check (public.is_crm_user());

create policy payments_crm_update
  on public.payments for update
  using (public.is_crm_user())
  with check (public.is_crm_user());

-- Deliberately no payments_crm_delete policy.

-- ============================================================
-- Manual bootstrap step required after this migration is applied
-- (NOT part of this migration — do not embed personal identifiers here):
--
-- public.app_users has no INSERT policy for the authenticated role, by
-- design (see above). That means once this migration is live, EVERY
-- Supabase Auth user — including Gal, even though her auth.users account
-- now exists — still has zero CRM access, because there is no matching
-- app_users row yet. The very first app_users row cannot be created
-- through the app; it must be inserted once, manually, through a trusted
-- channel that bypasses RLS (e.g. the Supabase Dashboard's SQL Editor,
-- which runs as a privileged role), referencing Gal's real auth.users id
-- as shown in Authentication -> Users:
--
--   insert into public.app_users (auth_user_id, full_name, is_active)
--   values ('<gal-auth-user-id-from-dashboard>', 'Gal', true);
--
-- This UUID is a personal identifier and must never be typed into chat
-- or committed into a migration file — run it directly yourself when
-- ready, after this migration has actually been pushed.
-- ============================================================
