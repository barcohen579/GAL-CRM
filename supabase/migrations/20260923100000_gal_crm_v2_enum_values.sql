-- GAL CRM V2 (Lead Workflow V2) — enum additions ONLY.
--
-- Deliberately its own migration with no other DDL/DML: Postgres does
-- not allow a value added via ALTER TYPE ... ADD VALUE to be used in
-- the same transaction that added it (same precedent and reasoning as
-- 20260904160000_..._follow_up_task_source_automatic.sql). The next
-- migration (20260923101000_..._lead_workflow_v2.sql) uses these.

-- A delivery row that will never be sent because its reminder is no
-- longer relevant (task completed/cancelled/superseded before the
-- reminder went out, or a pre-V2 legacy row retired by the V2
-- transition). Terminal, like SENT — never claimed again.
alter type public.follow_up_reminder_status add value if not exists 'SKIPPED';

-- Expanded LOST reasons (owner-approved list). Existing values are kept
-- (PRICE, NO_RESPONSE, CHOSE_COMPETITOR, NOT_INTERESTED, OTHER are
-- reused for the matching new labels; TIMING stays readable for
-- historical rows but is no longer offered in the UI).
alter type public.lead_lost_reason add value if not exists 'TOO_FAR';
alter type public.lead_lost_reason add value if not exists 'SCHEDULE_MISMATCH';
alter type public.lead_lost_reason add value if not exists 'NO_CHILDCARE';
alter type public.lead_lost_reason add value if not exists 'START_LATER';
alter type public.lead_lost_reason add value if not exists 'SERVICE_NOT_OFFERED';
alter type public.lead_lost_reason add value if not exists 'NOT_A_FIT';
alter type public.lead_lost_reason add value if not exists 'INVALID_LEAD';
