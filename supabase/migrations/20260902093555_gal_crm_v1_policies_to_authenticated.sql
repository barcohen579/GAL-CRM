-- GAL CRM V1 — tighten policy roles to `authenticated`
--
-- Depends on: 20260902083853_gal_crm_v1_authorization_rls.sql, which
-- created 30 policies without an explicit `TO` clause. Postgres defaults
-- an omitted `TO` to PUBLIC, so every one of those policies currently has
-- roles = {public} — meaning the `anon` role is also considered when
-- evaluating them, not just `authenticated`.
--
-- Why this matters in practice: EXECUTE on public.is_crm_user() is
-- granted only to `authenticated` (revoked from PUBLIC). An `anon`
-- request hitting a table whose policy is scoped to `public` still has
-- that policy evaluated for it, which means Postgres tries to call
-- is_crm_user() on the anon role's behalf and hits a permission-denied
-- error on the function itself, rather than the request simply matching
-- "no applicable policy" and returning zero rows. Access was never
-- actually granted in that path (no row was ever returned to anon), but
-- it's a rougher failure mode than intended and needlessly reveals the
-- helper function's name/existence to unauthenticated probing.
--
-- This migration changes every existing policy's role scope from PUBLIC
-- to `authenticated`, using ALTER POLICY ... TO authenticated. This form
-- of ALTER POLICY changes ONLY the roles the policy applies to — it does
-- not touch the USING or WITH CHECK expression, so behavior for every
-- authorized/unauthorized `authenticated` caller is byte-for-byte
-- unchanged. After this migration, `anon` requests fail cleanly at the
-- "no policy applies" layer (empty result, no error, no function-name
-- disclosure) instead of hitting the function's permission check.
--
-- Nothing else changes:
--   - public.is_crm_user() itself is untouched (already SECURITY DEFINER,
--     STABLE, search_path pinned, EXECUTE already authenticated-only).
--   - No table, column, constraint, index, or trigger changes.
--   - No data is touched. app_users remains empty. Gal is still not
--     bootstrapped — that remains a separate, later, controlled step.
--   - No Meta tables, no notification-provider tables.

-- ============================================================
-- app_users
-- ============================================================
alter policy app_users_crm_select on public.app_users to authenticated;

-- ============================================================
-- contacts
-- ============================================================
alter policy contacts_crm_select on public.contacts to authenticated;
alter policy contacts_crm_insert on public.contacts to authenticated;
alter policy contacts_crm_update on public.contacts to authenticated;
alter policy contacts_crm_delete on public.contacts to authenticated;

-- ============================================================
-- leads
-- ============================================================
alter policy leads_crm_select on public.leads to authenticated;
alter policy leads_crm_insert on public.leads to authenticated;
alter policy leads_crm_update on public.leads to authenticated;
alter policy leads_crm_delete on public.leads to authenticated;

-- ============================================================
-- lead_stage_events (SELECT/INSERT only — unchanged, still no
-- UPDATE/DELETE policy exists on this table)
-- ============================================================
alter policy lead_stage_events_crm_select on public.lead_stage_events to authenticated;
alter policy lead_stage_events_crm_insert on public.lead_stage_events to authenticated;

-- ============================================================
-- touchpoints
-- ============================================================
alter policy touchpoints_crm_select on public.touchpoints to authenticated;
alter policy touchpoints_crm_insert on public.touchpoints to authenticated;
alter policy touchpoints_crm_update on public.touchpoints to authenticated;
alter policy touchpoints_crm_delete on public.touchpoints to authenticated;

-- ============================================================
-- follow_up_tasks
-- ============================================================
alter policy follow_up_tasks_crm_select on public.follow_up_tasks to authenticated;
alter policy follow_up_tasks_crm_insert on public.follow_up_tasks to authenticated;
alter policy follow_up_tasks_crm_update on public.follow_up_tasks to authenticated;
alter policy follow_up_tasks_crm_delete on public.follow_up_tasks to authenticated;

-- ============================================================
-- customers
-- ============================================================
alter policy customers_crm_select on public.customers to authenticated;
alter policy customers_crm_insert on public.customers to authenticated;
alter policy customers_crm_update on public.customers to authenticated;
alter policy customers_crm_delete on public.customers to authenticated;

-- ============================================================
-- purchases
-- ============================================================
alter policy purchases_crm_select on public.purchases to authenticated;
alter policy purchases_crm_insert on public.purchases to authenticated;
alter policy purchases_crm_update on public.purchases to authenticated;
alter policy purchases_crm_delete on public.purchases to authenticated;

-- ============================================================
-- payments (SELECT/INSERT/UPDATE only — unchanged, still no DELETE
-- policy exists on this table; the prevent_payment_fact_changes trigger
-- from the previous migration is untouched and still applies to every
-- role, including service_role)
-- ============================================================
alter policy payments_crm_select on public.payments to authenticated;
alter policy payments_crm_insert on public.payments to authenticated;
alter policy payments_crm_update on public.payments to authenticated;
