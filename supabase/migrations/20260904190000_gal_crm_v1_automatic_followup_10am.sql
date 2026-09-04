-- GAL CRM — Automatic Lead Follow-Up always due 10:00 Israel time (was
-- 09:00), on the next eligible business day (Sun-Thu; Fri/Sat -> Sun).
--
-- Product decision (see the task's own spec + examples): every newly
-- created Lead's Day-0 AUTOMATIC follow-up should land at a single,
-- predictable morning slot regardless of what time the lead entered
-- the CRM. Deliberately NOT a day-selection change — the existing
-- next_eligible_follow_up_date() logic ("the next Israel calendar
-- date strictly after created_at's own date, skipping Fri/Sat")
-- already produces exactly the day every one of the task's own worked
-- examples expects (Sun->Mon, Wed->Thu, Thu->Sun, Fri->Sun, Sat->Sun);
-- only the HOUR baked into create_automatic_followup_for_new_lead()
-- changes, from '09:00' to '10:00'.
--
-- Deliberately does NOT touch, and this migration's only change is
-- CREATE OR REPLACE on the one function below plus its own comment:
--   - MANUAL follow-ups: createFollowUp/create_manual_follow_up_for_lead
--     never call this function and never derive a due_at from it —
--     Gal's own explicitly chosen date/time (e.g. Monday 16:00) is
--     untouched, exactly as before.
--   - The daily AUTOMATIC escalation loop (processAutomaticEscalations
--     in app/api/cron/follow-up-notifications/route.ts): it re-sends
--     against the SAME Day-0 follow_up_tasks.due_at every eligible
--     day and never recomputes a new due_at of its own — there is no
--     second "9am vs 10am" decision point to fix there. Once this
--     migration lands, every NEW Day-0 row (and, after the paired
--     backfill migration below, every currently-PENDING one) is
--     already 10:00, so escalation's own reused due_at is 10:00 too,
--     with zero code change needed in the escalation path itself.
--   - next_eligible_follow_up_date() (day-selection only, no hour) —
--     untouched, still the single source of truth for which DAY.
--   - The one-time historical backfill in
--     20260904162000_..._followup_escalation_production_backfill.sql
--     (already applied, its own migration history preserved as-is —
--     see the paired data-cleanup migration below for normalizing
--     what it created).

create or replace function public.create_automatic_followup_for_new_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due_date date;
begin
  v_due_date := public.next_eligible_follow_up_date(new.created_at);

  insert into public.follow_up_tasks (lead_id, title, due_at, status, source)
  values (
    new.id,
    'מעקב אוטומטי לליד חדש',
    (v_due_date + time '10:00') at time zone 'Asia/Jerusalem',
    'PENDING',
    'AUTOMATIC'
  );

  return new;
end;
$$;

comment on function public.create_automatic_followup_for_new_lead() is
  'AFTER INSERT trigger on leads: creates the Day-0 AUTOMATIC '
  'follow_up_tasks row every new lead needs, regardless of source '
  '(manual or Meta Lead Ads), due 10:00 Israel time on the next '
  'eligible business day. SECURITY DEFINER — see this function''s own '
  'comment above.';
