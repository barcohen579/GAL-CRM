-- GAL CRM V1 — required base object privileges for `authenticated`
--
-- Root cause this migration fixes:
--
-- All 9 CRM tables had ROW LEVEL SECURITY enabled with correct policies
-- (migrations 2 and 3), but the `authenticated` role was never granted
-- the underlying SQL object privileges (SELECT/INSERT/UPDATE/DELETE) on
-- any of them — only REFERENCES, TRIGGER, TRUNCATE were present (an
-- artifact of this project having automatic-RLS-with-default-grants
-- disabled at creation time). PostgreSQL checks base GRANTs BEFORE it
-- ever evaluates RLS policies, so every query from an authenticated CRM
-- user failed with 42501 "permission denied for table ..." — RLS was
-- never actually reached. Confirmed live via
-- information_schema.role_table_grants before writing this migration.
--
-- This migration adds exactly the base privileges needed to match the
-- CRUD model already expressed by the RLS policies from migration 2/3 —
-- nothing broader. RLS continues to do the real row-level
-- authorization; these GRANTs only clear the precondition RLS depends
-- on.
--
-- Explicitly NOT touched by this migration:
--   - No RLS policy is created, dropped, or altered.
--   - public.is_crm_user() is not touched.
--   - `anon` receives no new privileges on any table — still zero
--     SELECT/INSERT/UPDATE/DELETE, exactly as before.
--   - TRUNCATE is not granted here. It was already independently
--     present on `authenticated` for every table before this migration;
--     that pre-existing grant is deliberately left as-is (neither
--     re-granted nor revoked) rather than treated as part of the CRUD
--     model this migration is aligning.
--
-- Privilege model (mirrors each table's existing RLS policies exactly):
--   app_users          -> SELECT only
--   contacts           -> SELECT, INSERT, UPDATE, DELETE
--   leads              -> SELECT, INSERT, UPDATE, DELETE
--   lead_stage_events  -> SELECT, INSERT only
--   touchpoints        -> SELECT, INSERT, UPDATE, DELETE
--   follow_up_tasks    -> SELECT, INSERT, UPDATE, DELETE
--   customers          -> SELECT, INSERT, UPDATE, DELETE
--   purchases          -> SELECT, INSERT, UPDATE, DELETE
--   payments           -> SELECT, INSERT, UPDATE (no DELETE)

grant select on public.app_users to authenticated;

grant select, insert, update, delete on public.contacts to authenticated;

grant select, insert, update, delete on public.leads to authenticated;

grant select, insert on public.lead_stage_events to authenticated;

grant select, insert, update, delete on public.touchpoints to authenticated;

grant select, insert, update, delete on public.follow_up_tasks to authenticated;

grant select, insert, update, delete on public.customers to authenticated;

grant select, insert, update, delete on public.purchases to authenticated;

grant select, insert, update on public.payments to authenticated;
