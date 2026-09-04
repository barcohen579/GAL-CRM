-- GAL CRM — one-time Production backfill: normalize existing PENDING
-- AUTOMATIC follow-ups from 09:00 to 10:00 Israel time, same date.
--
-- Kept in its own migration, separate from
-- 20260904190000_..._automatic_followup_10am.sql, for the same reason
-- every prior structural-vs-data-cleanup pair in this schema was split
-- (20260904161000 vs 20260904162000; 20260904170000 vs 20260904171000):
-- the trigger's own behavior change and this one-off data correction
-- each get their own, individually reviewable migration history.
--
-- As of the READ-ONLY inspection run for this task, Production has
-- exactly 6 PENDING AUTOMATIC follow_up_tasks rows, ALL due
-- 2026-09-06 09:00 Israel time (all Day-0, all from the same original
-- batch) — reported to, and explicitly pre-approved by, the project
-- owner ("if they are clearly system-generated AUTOMATIC tasks, it is
-- approved to normalize their future due time to 10:00 on their
-- appropriate eligible day"). Their existing DATE is already correct
-- (next_eligible_follow_up_date's own day-selection logic is
-- unchanged by this whole task) — only the time-of-day moves.
--
-- Scoped by source = 'AUTOMATIC' AND status = 'PENDING' only:
--   - Never touches a MANUAL follow-up's date/time, whatever it is —
--     Gal's own explicitly chosen time is never "system-generated"
--     and this backfill has no business rewriting it.
--   - Never touches a COMPLETED/CANCELLED row (any source) — historical
--     follow-ups are left exactly as they were; only rows still
--     actionable going forward are normalized.
-- Idempotent: the WHERE clause only ever matches a row whose current
-- due_at does not already equal 10:00 Israel time on its own existing
-- date, so a second run touches zero additional rows.

update public.follow_up_tasks
set due_at = (((due_at at time zone 'Asia/Jerusalem')::date + time '10:00') at time zone 'Asia/Jerusalem'),
    updated_at = now()
where source = 'AUTOMATIC'
  and status = 'PENDING'
  and due_at <> (((due_at at time zone 'Asia/Jerusalem')::date + time '10:00') at time zone 'Asia/Jerusalem');
