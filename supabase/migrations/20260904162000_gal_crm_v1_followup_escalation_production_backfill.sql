-- One-time Production data backfill for the Automatic Lead Follow-Up
-- Escalation Loop — kept apart from the structural migration
-- (20260904161000_..._automatic_lead_followup_escalation.sql) so the
-- schema/behavior change and this one-off data change each have their
-- own, individually reviewable migration history (per the task's own
-- explicit "report before mutating" gate).
--
-- Every read behind this backfill was performed READ-ONLY before this
-- file was written; the full inspection and counts were reported to,
-- and explicitly approved by, the project owner before this migration
-- was applied. As of that inspection: 11 leads / 11 follow_up_tasks
-- total (5 NEW, 2 TRIAL_COMPLETED, 4 WON, 0 LOST), 8 PENDING + 3
-- COMPLETED, ALL source = 'MANUAL' (zero AUTOMATIC/AI_SUGGESTED rows
-- existed — that value/path did not exist before this feature), and
-- ALL created within one ~15-minute window, consistent with demo/seed
-- data rather than weeks of accumulated real usage.
--
-- Three DISTINCT, individually-approved changes, each idempotent (safe
-- to re-run — a second run touches zero additional rows):
--
--   1. Enroll existing NEW-stage leads into the automatic escalation
--      loop retroactively — since the trigger only fires on a lead's
--      own INSERT, these 5 leads (created before this feature existed)
--      never got a Day-0 AUTOMATIC follow-up. Uses now() as the
--      enrollment "Day 0" (not each lead's original created_at) — they
--      are being enrolled today, not backdated. Every one of these 5
--      leads already has its own MANUAL PENDING follow-up (confirmed
--      during inspection), so isAutomaticEscalationEligible's
--      "competing manual follow-up" rule immediately suspends any
--      escalation EMAIL for them — this backfill creates the tracking
--      row only, it does not and cannot trigger any email by itself
--      (the cron route is not invoked by a migration).
--   2. Restore the follow_up_reminder_deliveries invariant
--      ("every follow_up_tasks row always has exactly one delivery
--      row", normally guaranteed by the create_follow_up_reminder_delivery
--      trigger) for every existing follow_up_tasks row that predates
--      that trigger's own migration and so never got one — all 11,
--      not only the 8 PENDING ones, so the invariant the notifications
--      migration itself documents is fully restored, not just
--      partially. A COMPLETED/CANCELLED task's delivery row is inert
--      (isReminderEligible's own taskStatus check keeps it PENDING-
--      forever-unclaimed) — this does not by itself send anything.
--   3. Cancel the 2 confirmed stale PENDING follow-ups already
--      belonging to WON leads (found during inspection), applying the
--      SAME auto-close semantics (CANCELLED + auto_closed_reason) the
--      new change_lead_stage()/convert_lead_to_won() now apply going
--      forward — expressed generically (WON OR LOST leads with a
--      stale PENDING follow-up), not as two hardcoded ids, so it also
--      covers any LOST lead in the same state (none exist today, but
--      this keeps the statement itself the actual source of truth
--      rather than a one-off list).
--
-- None of this can, by itself, send a single real email: this
-- migration only ever INSERTs/UPDATEs rows in follow_up_tasks and the
-- two delivery-tracking tables — it never calls the email provider, and
-- the cron route is not invoked by a migration. The next real cron
-- invocation is the first thing that could ever act on these rows, and
-- it will do so under the ordinary eligibility rules already covered by
-- this feature's own tests (weekend quiet days, competing manual
-- follow-ups, WON/LOST exclusion, once-per-day dedupe).

-- ============================================================
-- 1. Enroll existing NEW-stage leads (Day 0 = now).
-- ============================================================

insert into public.follow_up_tasks (lead_id, title, due_at, status, source)
select
  l.id,
  'מעקב אוטומטי לליד חדש',
  (public.next_eligible_follow_up_date(now()) + time '09:00') at time zone 'Asia/Jerusalem',
  'PENDING',
  'AUTOMATIC'
from public.leads l
where l.stage = 'NEW'
  and not exists (
    select 1 from public.follow_up_tasks fut
    where fut.lead_id = l.id and fut.source = 'AUTOMATIC'
  );

-- ============================================================
-- 2. Restore the "every follow_up_tasks row has a delivery row"
--    invariant for every pre-trigger row.
-- ============================================================

insert into public.follow_up_reminder_deliveries (follow_up_task_id, status)
select fut.id, 'PENDING'
from public.follow_up_tasks fut
where not exists (
  select 1 from public.follow_up_reminder_deliveries frd
  where frd.follow_up_task_id = fut.id
);

-- ============================================================
-- 3. Cancel stale PENDING follow-ups already belonging to WON/LOST
--    leads, with the same auto-close semantics used going forward.
-- ============================================================

update public.follow_up_tasks fut
set status = 'CANCELLED',
    auto_closed_reason = case l.stage
      when 'WON' then 'הליד הפך ללקוחה (WON) — המעקב בוטל אוטומטית (ניקוי נתונים היסטוריים)'
      when 'LOST' then 'הליד סומן כאבוד (LOST) — המעקב בוטל אוטומטית (ניקוי נתונים היסטוריים)'
    end,
    updated_at = now()
from public.leads l
where fut.lead_id = l.id
  and l.stage in ('WON', 'LOST')
  and fut.status = 'PENDING';
