-- GAL CRM V2 — one-time Production data transition to Lead Workflow V2.
--
-- NOT YET APPLIED — requires the owner's explicit approval of the
-- transition plan (read-only audit of 2026-09-23). Kept separate from the
-- structural migration (20260923101000) per this repo's established
-- "structural vs one-off data change" split. Idempotent: a second run
-- touches zero rows. Never deletes anything; history (tasks, stage
-- events, escalation/digest/new-lead ledgers) is preserved as-is.
--
-- Goal: no historical notification is ever re-sent, the old daily
-- escalation loop is fully stopped, pending MANUAL follow-ups are kept,
-- and every remaining PENDING task follows the V2 rules.

do $$
declare
  v_n integer;
begin
  -- 1. AUTOMATIC tasks on leads that are already being handled (stage
  --    past NEW) or that already have a pending MANUAL follow-up are
  --    closed — exactly what V2 does going forward (change_lead_stage /
  --    create_manual_follow_up_for_lead). The sync trigger marks their
  --    unsent delivery rows SKIPPED.
  update public.follow_up_tasks t
  set status = 'CANCELLED',
      auto_closed_reason = 'נסגר במעבר לתהליך החדש — הליד כבר בטיפול',
      updated_at = now()
  from public.leads l
  where l.id = t.lead_id
    and t.source = 'AUTOMATIC'
    and t.status = 'PENDING'
    and (
      l.stage in ('CONTACTED', 'INTERESTED', 'TRIAL_BOOKED', 'TRIAL_COMPLETED')
      or exists (
        select 1 from public.follow_up_tasks m
        where m.lead_id = t.lead_id and m.source = 'MANUAL' and m.status = 'PENDING'
      )
    );
  get diagnostics v_n = row_count;
  raise notice 'V2 transition 1: closed % AUTOMATIC task(s) on leads already in progress', v_n;

  -- 2. AUTOMATIC tasks still PENDING on NEW leads that ALREADY received at
  --    least one pre-V2 escalation email: that email was their new-lead
  --    reminder. The task stays PENDING (visible in the CRM as an overdue
  --    "ליד חדש — ליצור קשר ראשון"), but its V2 delivery is retired so no
  --    further email is ever sent for it.
  update public.follow_up_reminder_deliveries d
  set status = 'SKIPPED',
      skipped_reason = 'legacy: lead already emailed by the pre-V2 daily escalation'
  from public.follow_up_tasks t
  where t.id = d.follow_up_task_id
    and t.source = 'AUTOMATIC'
    and t.status = 'PENDING'
    and d.status in ('PENDING', 'FAILED')
    and exists (
      select 1 from public.lead_auto_escalation_deliveries e
      where e.follow_up_task_id = t.id and e.status = 'SENT'
    );
  get diagnostics v_n = row_count;
  raise notice 'V2 transition 2: retired % already-notified AUTOMATIC delivery row(s)', v_n;

  -- 3. Delivery rows of tasks that were already closed before V2 (left
  --    PENDING forever by the old design — the audit's starvation source)
  --    get an explicit terminal SKIPPED state.
  update public.follow_up_reminder_deliveries d
  set status = 'SKIPPED',
      skipped_reason = 'legacy: task closed before V2'
  from public.follow_up_tasks t
  where t.id = d.follow_up_task_id
    and t.status <> 'PENDING'
    and d.status in ('PENDING', 'FAILED');
  get diagnostics v_n = row_count;
  raise notice 'V2 transition 3: retired % delivery row(s) of already-closed tasks', v_n;

  -- 4. Any interrupted pre-V2 send (SENDING) is retired rather than
  --    retried: pre-V2 sends carried no idempotency key, so a retry could
  --    duplicate an email that was actually delivered.
  update public.follow_up_reminder_deliveries
  set status = 'SKIPPED',
      skipped_reason = 'legacy: interrupted pre-V2 send, not retried'
  where status = 'SENDING';
  get diagnostics v_n = row_count;
  raise notice 'V2 transition 4: retired % interrupted pre-V2 SENDING row(s)', v_n;
end;
$$;
