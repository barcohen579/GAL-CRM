-- GAL CRM — one-time Production backfill + defense-in-depth index for
-- "at most one PENDING MANUAL follow-up per Lead".
--
-- NOT YET APPLIED TO PRODUCTION — see the task's own "IMPORTANT
-- PRODUCTION GATE": this file is prepared and reviewable, but must not
-- be pushed to the linked Production database until Gal has seen the
-- read-only inspection report (which Leads currently violate the
-- invariant, and which of their MANUAL rows is recommended as the
-- surviving/current one) and explicitly approved this exact treatment.
--
-- Kept in its own migration, separate from
-- 20260904170000_..._one_current_manual_follow_up_rpc.sql, for the same
-- reason 20260904161000 (structural) and 20260904162000 (one-time
-- backfill) were split: the schema/behavior change and the one-off data
-- change each get their own, individually reviewable migration history.
-- This migration is idempotent (re-running it is a no-op the second
-- time) and touches ONLY rows that already violate the new invariant —
-- every other follow_up_tasks row, of any source or status, is
-- untouched.
--
-- As of the READ-ONLY inspection run for this task, exactly one Lead in
-- Production violates the invariant: ליד בדיקה
-- (bc67a3fa-2223-4dcf-9990-6b550175aa47), with two PENDING MANUAL rows:
--   - 5e594e3a-e39a-4d36-a0cc-ab83f8fe6990 "מעקב מול ליד בדיקה"
--     created 2026-09-04 13:02:20 UTC, no notes — the row the
--     since-removed Add-Lead-flow's optional follow-up-date field
--     auto-created moments after the lead itself.
--   - 4c756383-9496-4c11-bef2-30a5ca7cccf9 "ליד בדיקה"
--     created 2026-09-04 13:07:27 UTC, notes "גל גל גל" — created
--     afterwards, by hand, via the follow-ups UI ("מעקב חדש").
-- The backfill below is written generically (by created_at, not by any
-- hardcoded id) so it applies correctly to this Lead and to any other
-- Lead that happens to violate the invariant by the time this actually
-- runs, without needing to special-case ליד בדיקה by name.

do $$
declare
  v_count integer;
begin
  -- For every Lead with more than one PENDING MANUAL follow-up, keep
  -- only the most recently CREATED one PENDING (the newest one is, by
  -- construction, the one carrying Gal's latest context — this mirrors
  -- exactly what create_manual_follow_up_for_lead does for every new
  -- MANUAL follow-up going forward: newest wins, older superseded) and
  -- CANCEL the rest, recording why. Never deletes — full history
  -- preserved, same as every other auto-cancel path in this schema.
  with ranked as (
    select
      id,
      row_number() over (partition by lead_id order by created_at desc) as rn
    from public.follow_up_tasks
    where source = 'MANUAL' and status = 'PENDING' and lead_id is not null
  )
  update public.follow_up_tasks f
  set status = 'CANCELLED',
      auto_closed_reason = 'הוחלף במעקב ידני חדש שנוצרה לו (ניקוי חד-פעמי, ' ||
        'ראה 20260904171000_..._one_pending_manual_per_lead_backfill_and_index.sql)',
      updated_at = now()
  from ranked
  where f.id = ranked.id
    and ranked.rn > 1;

  get diagnostics v_count = row_count;
  raise notice 'one_pending_manual_per_lead backfill: superseded % pre-existing PENDING MANUAL row(s)', v_count;
end;
$$;

-- Now safe to enforce as a real DB invariant, same "defense-in-depth on
-- top of a mechanism that should already guarantee it" precedent as
-- follow_up_tasks_one_automatic_per_lead above (20260904161000): every
-- MANUAL follow-up creation already goes through
-- create_manual_follow_up_for_lead's own per-lead lock, but this index
-- means the invariant holds at the database level even against a future
-- bug that bypasses it, or a direct psql/service-role write.
create unique index follow_up_tasks_one_pending_manual_per_lead
  on public.follow_up_tasks (lead_id)
  where source = 'MANUAL' and status = 'PENDING' and lead_id is not null;
