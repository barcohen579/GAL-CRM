-- GAL CRM — Lead Workflow V2 SQL regression suite.
--
-- Same convention as every other file in supabase/tests: the whole run
-- is ONE transaction that is ROLLED BACK at the end, so nothing it
-- creates is ever committed. All test rows are dated in 2020 and every
-- claim_due_follow_up_reminders() call passes an explicit 2020 p_now,
-- so the claim assertions can never see (or be affected by) real rows,
-- whose remind_at values are all in 2026+. No email is sent: SQL never
-- talks to the email provider.
begin;

do $$
declare
  v_contact uuid;
  v_lead uuid;
  v_lead2 uuid;
  v_auto public.follow_up_tasks;
  v_manual public.follow_up_tasks;
  v_manual2 public.follow_up_tasks;
  v_status text;
  v_reason text;
  v_remind timestamptz;
  v_count int;
  v_ids uuid[];
  v_stage public.lead_stage;
  v_conv uuid;
  v_row record;
  v_ok boolean;
begin
  -- ============================================================
  -- 1. Reminder timing
  -- ============================================================
  insert into public.contacts (full_name) values ('V2 test contact') returning id into v_contact;
  -- Sunday 2020-01-05 12:00 Israel (IST) -> AUTOMATIC due Monday 10:00 IST = 08:00Z
  insert into public.leads (contact_id, created_at) values (v_contact, '2020-01-05 10:00:00+00') returning id into v_lead;

  select * into v_auto from public.follow_up_tasks where lead_id = v_lead and source = 'AUTOMATIC';
  if v_auto.due_at <> '2020-01-06 08:00:00+00' then
    raise exception 'ASSERTION FAILED (1a): automatic due_at %', v_auto.due_at;
  end if;
  select remind_at, status::text into v_remind, v_status
  from public.follow_up_reminder_deliveries where follow_up_task_id = v_auto.id;
  if v_remind <> v_auto.due_at or v_status <> 'PENDING' then
    raise exception 'ASSERTION FAILED (1b): automatic remind_at % status %', v_remind, v_status;
  end if;

  -- MANUAL: due Tuesday -> Wednesday 10:00; Thursday/Friday/Saturday -> Sunday 10:00.
  if public.follow_up_reminder_at('MANUAL', '2020-01-07 18:00:00+00') <> '2020-01-08 08:00:00+00' then
    raise exception 'ASSERTION FAILED (1c): Tue -> Wed 10:00';
  end if;
  if public.follow_up_reminder_at('MANUAL', '2020-01-09 08:00:00+00') <> '2020-01-12 08:00:00+00'
     or public.follow_up_reminder_at('MANUAL', '2020-01-10 08:00:00+00') <> '2020-01-12 08:00:00+00'
     or public.follow_up_reminder_at('MANUAL', '2020-01-11 08:00:00+00') <> '2020-01-12 08:00:00+00' then
    raise exception 'ASSERTION FAILED (1d): Thu/Fri/Sat -> Sun 10:00';
  end if;
  -- DST: Thu 2026-10-22 -> Sun 2026-10-25 10:00 IST (08:00Z); Thu 2026-03-26 -> Sun 2026-03-29 10:00 IDT (07:00Z)
  if public.follow_up_reminder_at('MANUAL', '2026-10-22 09:00:00+00') <> '2026-10-25 08:00:00+00'
     or public.follow_up_reminder_at('MANUAL', '2026-03-26 09:00:00+00') <> '2026-03-29 07:00:00+00' then
    raise exception 'ASSERTION FAILED (1e): DST handling';
  end if;

  -- ============================================================
  -- 2. Manual follow-up closes the AUTOMATIC one; supersede keeps history
  -- ============================================================
  select * into v_manual from public.create_manual_follow_up_for_lead(v_lead, 'first', null, '2020-01-07 10:00:00+00');
  select status::text, auto_closed_reason into v_status, v_reason from public.follow_up_tasks where id = v_auto.id;
  if v_status <> 'CANCELLED' or v_reason is null then
    raise exception 'ASSERTION FAILED (2a): AUTOMATIC not closed by manual follow-up (%)', v_status;
  end if;
  select status::text into v_status from public.follow_up_reminder_deliveries where follow_up_task_id = v_auto.id;
  if v_status <> 'SKIPPED' then
    raise exception 'ASSERTION FAILED (2b): AUTOMATIC delivery should be SKIPPED, got %', v_status;
  end if;
  select remind_at into v_remind from public.follow_up_reminder_deliveries where follow_up_task_id = v_manual.id;
  if v_remind <> '2020-01-08 08:00:00+00' then
    raise exception 'ASSERTION FAILED (2c): manual remind_at %', v_remind;
  end if;

  select * into v_manual2 from public.create_manual_follow_up_for_lead(v_lead, 'second', 'note', '2020-01-08 10:00:00+00');
  select status::text into v_status from public.follow_up_tasks where id = v_manual.id;
  if v_status <> 'CANCELLED' then
    raise exception 'ASSERTION FAILED (2d): previous manual not superseded';
  end if;
  select status::text into v_status from public.follow_up_reminder_deliveries where follow_up_task_id = v_manual.id;
  if v_status <> 'SKIPPED' then
    raise exception 'ASSERTION FAILED (2e): superseded manual delivery should be SKIPPED, got %', v_status;
  end if;
  select count(*) into v_count from public.follow_up_tasks
  where lead_id = v_lead and source = 'MANUAL' and status = 'PENDING';
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (2f): expected exactly one PENDING MANUAL, got %', v_count;
  end if;

  -- ============================================================
  -- 3. Claiming: due only, oldest first, disjoint, weekend, retry, stale, exhaustion
  -- ============================================================
  -- Thursday 2020-01-09 09:00Z: v_manual2 (remind Thu 2020-01-09 08:00Z) is due.
  select array_agg(delivery_id) into v_ids
  from public.claim_due_follow_up_reminders(10, 5, 30, 15, '2020-01-09 07:59:00+00');
  if v_ids is not null then
    raise exception 'ASSERTION FAILED (3a): claimed before remind_at: %', v_ids;
  end if;

  -- Friday / Saturday: nothing, even though due.
  select count(*) into v_count from public.claim_due_follow_up_reminders(10, 5, 30, 15, '2020-01-10 09:00:00+00');
  if v_count <> 0 then raise exception 'ASSERTION FAILED (3b): claimed on Friday'; end if;
  select count(*) into v_count from public.claim_due_follow_up_reminders(10, 5, 30, 15, '2020-01-11 09:00:00+00');
  if v_count <> 0 then raise exception 'ASSERTION FAILED (3c): claimed on Saturday'; end if;

  select count(*) into v_count from public.claim_due_follow_up_reminders(10, 5, 30, 15, '2020-01-09 09:00:00+00');
  if v_count <> 1 then raise exception 'ASSERTION FAILED (3d): expected 1 claim, got %', v_count; end if;
  select count(*) into v_count from public.claim_due_follow_up_reminders(10, 5, 30, 15, '2020-01-09 09:00:00+00');
  if v_count <> 0 then raise exception 'ASSERTION FAILED (3e): a SENDING row was claimed twice'; end if;

  -- Simulate a crash: row stays SENDING. Not reclaimed before 15 min, reclaimed after.
  select count(*) into v_count from public.claim_due_follow_up_reminders(10, 5, 30, 15, '2020-01-09 09:10:00+00');
  if v_count <> 0 then raise exception 'ASSERTION FAILED (3f): stale reclaim too early'; end if;
  select count(*) into v_count from public.claim_due_follow_up_reminders(10, 5, 30, 15, '2020-01-09 09:16:00+00');
  if v_count <> 1 then raise exception 'ASSERTION FAILED (3g): stale SENDING not reclaimed'; end if;

  -- FAILED: retried only after backoff; exhausted after max attempts.
  update public.follow_up_reminder_deliveries set status = 'FAILED'
  where follow_up_task_id = v_manual2.id;
  select count(*) into v_count from public.claim_due_follow_up_reminders(10, 5, 30, 15, '2020-01-09 09:30:00+00');
  if v_count <> 0 then raise exception 'ASSERTION FAILED (3h): FAILED retried inside backoff'; end if;
  select count(*) into v_count from public.claim_due_follow_up_reminders(10, 5, 30, 15, '2020-01-09 09:47:00+00');
  if v_count <> 1 then raise exception 'ASSERTION FAILED (3i): FAILED not retried after backoff'; end if;
  update public.follow_up_reminder_deliveries set status = 'FAILED', attempt_count = 5
  where follow_up_task_id = v_manual2.id;
  select count(*) into v_count from public.claim_due_follow_up_reminders(10, 5, 30, 15, '2020-01-09 12:00:00+00');
  if v_count <> 0 then raise exception 'ASSERTION FAILED (3j): exhausted row retried'; end if;
  -- A SENDING row that died on its last attempt is finalized as FAILED.
  update public.follow_up_reminder_deliveries set status = 'SENDING', attempt_count = 5, last_attempted_at = '2020-01-09 12:00:00+00'
  where follow_up_task_id = v_manual2.id;
  perform public.claim_due_follow_up_reminders(10, 5, 30, 15, '2020-01-09 13:00:00+00');
  select status::text into v_status from public.follow_up_reminder_deliveries where follow_up_task_id = v_manual2.id;
  if v_status <> 'FAILED' then raise exception 'ASSERTION FAILED (3k): exhausted SENDING not finalized (%)', v_status; end if;

  -- Completing the task marks a still-unsent delivery SKIPPED.
  update public.follow_up_reminder_deliveries set status = 'PENDING', attempt_count = 0 where follow_up_task_id = v_manual2.id;
  update public.follow_up_tasks set status = 'COMPLETED', completed_at = now() where id = v_manual2.id;
  select status::text into v_status from public.follow_up_reminder_deliveries where follow_up_task_id = v_manual2.id;
  if v_status <> 'SKIPPED' then raise exception 'ASSERTION FAILED (3l): completed task delivery %', v_status; end if;
  select count(*) into v_count from public.claim_due_follow_up_reminders(10, 5, 30, 15, '2020-01-12 09:00:00+00');
  if v_count <> 0 then raise exception 'ASSERTION FAILED (3m): completed task claimed'; end if;

  -- ============================================================
  -- 4. Stage out of NEW closes the AUTOMATIC task; conversation updates
  -- ============================================================
  insert into public.leads (contact_id, created_at) values (v_contact, '2020-01-05 10:00:00+00') returning id into v_lead2;
  select * into v_auto from public.follow_up_tasks where lead_id = v_lead2 and source = 'AUTOMATIC';

  -- NO_ANSWER with a requested stage change: history row kept, stage unchanged.
  v_conv := public.record_lead_conversation(v_lead2, 'NO_ANSWER', null, 'CONTACTED', null, null, null);
  select stage into v_stage from public.leads where id = v_lead2;
  if v_stage <> 'NEW' then raise exception 'ASSERTION FAILED (4a): NO_ANSWER changed stage to %', v_stage; end if;
  select status::text into v_status from public.follow_up_tasks where id = v_auto.id;
  if v_status <> 'PENDING' then raise exception 'ASSERTION FAILED (4b): NO_ANSWER closed the automatic task'; end if;

  -- CALL_TOMORROW + follow-up + stage: one transaction, all linked.
  v_conv := public.record_lead_conversation(v_lead2, 'CALL_TOMORROW', 'ביקשה שנדבר מחר', 'CONTACTED', 'להתקשר אליה', '2020-01-07 08:00:00+00', null);
  select * into v_row from public.lead_conversation_updates where id = v_conv;
  if v_row.stage_before <> 'NEW' or v_row.stage_after <> 'CONTACTED' or v_row.follow_up_task_id is null then
    raise exception 'ASSERTION FAILED (4c): conversation row % % %', v_row.stage_before, v_row.stage_after, v_row.follow_up_task_id;
  end if;
  select status::text into v_status from public.follow_up_tasks where id = v_row.follow_up_task_id;
  if v_status <> 'PENDING' then raise exception 'ASSERTION FAILED (4d): follow-up not created'; end if;
  select status::text into v_status from public.follow_up_tasks where id = v_auto.id;
  if v_status <> 'CANCELLED' then raise exception 'ASSERTION FAILED (4e): automatic not closed'; end if;
  select count(*) into v_count from public.lead_conversation_updates where lead_id = v_lead2;
  if v_count <> 2 then raise exception 'ASSERTION FAILED (4f): history not preserved (% rows)', v_count; end if;

  v_ok := false;
  begin
    perform public.record_lead_conversation(v_lead2, 'OTHER', '  ', null, null, null, null);
  exception when sqlstate 'GALC2' then v_ok := true;
  end;
  if not v_ok then raise exception 'ASSERTION FAILED (4g): OTHER without note accepted'; end if;

  -- ============================================================
  -- 5. LOST reasons
  -- ============================================================
  v_ok := false;
  begin
    perform public.change_lead_stage(v_lead2, 'LOST', null, null);
  exception when sqlstate 'GALL1' then v_ok := true;
  end;
  if not v_ok then raise exception 'ASSERTION FAILED (5a): LOST without reason accepted'; end if;

  v_ok := false;
  begin
    perform public.change_lead_stage(v_lead2, 'LOST', 'OTHER', '');
  exception when sqlstate 'GALL2' then v_ok := true;
  end;
  if not v_ok then raise exception 'ASSERTION FAILED (5b): OTHER without explanation accepted'; end if;

  perform public.change_lead_stage(v_lead2, 'LOST', 'TOO_FAR', 'גרה בחיפה');
  select * into v_row from public.lead_stage_events where lead_id = v_lead2 and to_stage = 'LOST';
  if v_row.lost_reason <> 'TOO_FAR' or v_row.lost_reason_note <> 'גרה בחיפה' or v_row.note <> 'TOO_FAR' then
    raise exception 'ASSERTION FAILED (5c): LOST reason not on stage history';
  end if;
  select count(*) into v_count from public.follow_up_tasks where lead_id = v_lead2 and status = 'PENDING';
  if v_count <> 0 then raise exception 'ASSERTION FAILED (5d): LOST left pending tasks'; end if;

  perform public.change_lead_stage(v_lead2, 'CONTACTED', null, null); -- reopen
  select * into v_row from public.lead_stage_events where lead_id = v_lead2 and to_stage = 'LOST';
  if v_row.lost_reason <> 'TOO_FAR' then raise exception 'ASSERTION FAILED (5e): reason lost after reopen'; end if;
  if (select lost_reason from public.leads where id = v_lead2) is not null
     or (select lost_reason_note from public.leads where id = v_lead2) is not null then
    raise exception 'ASSERTION FAILED (5f): reopened lead still carries a lost reason';
  end if;

  -- ============================================================
  -- 6. WON is final; no duplicate purchase
  -- ============================================================
  perform public.convert_lead_to_won(v_lead2, 'GROUP_TRAINING', null, 10000, 'ONE_TIME', '2020-01-10', null);
  v_ok := false;
  begin
    perform public.change_lead_stage(v_lead2, 'CONTACTED', null, null);
  exception when sqlstate 'GALW1' then v_ok := true;
  end;
  if not v_ok then raise exception 'ASSERTION FAILED (6a): WON lead moved back'; end if;

  update public.leads set stage = 'CONTACTED' where id = v_lead2; -- a lead reopened under pre-V2 rules
  v_ok := false;
  begin
    perform public.convert_lead_to_won(v_lead2, 'GROUP_TRAINING', null, 10000, 'ONE_TIME', '2020-01-11', null);
  exception when sqlstate 'GALW2' then v_ok := true;
  end;
  if not v_ok then raise exception 'ASSERTION FAILED (6b): re-WON created a duplicate purchase'; end if;
  select count(*) into v_count from public.purchases where lead_id = v_lead2;
  if v_count <> 1 then raise exception 'ASSERTION FAILED (6c): % purchases', v_count; end if;

  -- ============================================================
  -- 7. Atomic manual creation with duplicate warning
  -- ============================================================
  select * into v_row from public.create_lead_manually(
    'V2 manual', '+972 58-000-0417', null, null, null,
    array['GROUP_TRAINING', 'NUTRITION_COACHING']::public.service_type[], 'WALK_IN', null, false
  );
  if v_row.lead_id is null or v_row.duplicate_contact_id is not null then
    raise exception 'ASSERTION FAILED (7a): creation failed or false duplicate';
  end if;
  if (select count(*) from public.lead_interested_services where lead_id = v_row.lead_id) <> 2
     or (select count(*) from public.touchpoints where lead_id = v_row.lead_id and is_primary) <> 1
     or (select count(*) from public.follow_up_tasks where lead_id = v_row.lead_id and source = 'AUTOMATIC') <> 1 then
    raise exception 'ASSERTION FAILED (7b): services/touchpoint/automatic task missing';
  end if;
  v_lead := v_row.lead_id;

  select * into v_row from public.create_lead_manually('Someone', '058-000-0417', null, null, null, null, null, null, false);
  if v_row.lead_id is not null or v_row.duplicate_contact_id is null or v_row.duplicate_lead_id <> v_lead then
    raise exception 'ASSERTION FAILED (7c): duplicate phone not reported';
  end if;
  select * into v_row from public.create_lead_manually('Someone', '058-000-0417', null, null, null, null, null, null, true);
  if v_row.lead_id is null then raise exception 'ASSERTION FAILED (7d): explicit duplicate not created'; end if;

  raise notice 'lead_workflow_v2: ALL ASSERTIONS PASSED';
end;
$$;

rollback;
