-- Regression test for "One current MANUAL follow-up per Lead" (see
-- supabase/migrations/20260904170000_..._one_current_manual_follow_up_rpc.sql
-- and 20260904171000_..._one_pending_manual_per_lead_backfill_and_index.sql).
--
-- NOT YET RUNNABLE: create_manual_follow_up_for_lead and the partial
-- unique index this test exercises do not exist in Production until
-- both migrations above are applied — see the "IMPORTANT PRODUCTION
-- GATE" in the task this test was written for. Written and reviewed
-- now so it is ready to run immediately once those migrations are
-- approved and applied.
--
-- Same style as this project's other RPC/function regression tests: a
-- self-contained, ASSERTION-BASED (RAISEs on the first mismatch),
-- BEGIN/ROLLBACK script. Never sends a real email (DB state only) and
-- never leaves real rows behind.
--
-- Run with:
--   npx supabase db query --linked -f supabase/tests/one_current_manual_follow_up_per_lead.test.sql
--
-- A clean run prints only a final "ALL ASSERTIONS PASSED" row and
-- leaves the database completely unchanged (ROLLBACK at the end).

begin;

select set_config(
  'request.jwt.claims',
  json_build_object('sub', (select auth_user_id::text from public.app_users where is_active limit 1))::text,
  true
) as _ignore;

do $$
declare
  v_contact uuid;
  v_lead uuid;
  v_automatic_task record;
  v_first_manual public.follow_up_tasks;
  v_second_manual public.follow_up_tasks;
  v_count int;
  v_old_task record;
begin
  -----------------------------------------------------------------
  -- Setup: a fresh lead already has its Day-0 AUTOMATIC follow-up
  -- (create_automatic_followup_for_new_lead trigger) — untouched by
  -- everything below.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test One-Manual Lead') returning id into v_contact;
  insert into public.leads (contact_id) values (v_contact) returning id into v_lead;

  select * into v_automatic_task from public.follow_up_tasks where lead_id = v_lead and source = 'AUTOMATIC';
  if v_automatic_task.status <> 'PENDING' then
    raise exception 'ASSERTION FAILED (Setup): expected the Day-0 AUTOMATIC follow-up to be PENDING';
  end if;

  -----------------------------------------------------------------
  -- Scenario 1: creating the FIRST MANUAL follow-up for this lead via
  -- create_manual_follow_up_for_lead — nothing to supersede yet, the
  -- AUTOMATIC row is completely untouched.
  -----------------------------------------------------------------
  select * into v_first_manual from public.create_manual_follow_up_for_lead(
    v_lead, 'לחזור אליה מחר', null, now() + interval '1 day'
  );

  if v_first_manual.status <> 'PENDING' or v_first_manual.source <> 'MANUAL' then
    raise exception 'ASSERTION FAILED (Scenario 1): new MANUAL follow-up is not PENDING/MANUAL';
  end if;

  select count(*) into v_count
  from public.follow_up_tasks
  where lead_id = v_lead and source = 'MANUAL' and status = 'PENDING';
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (Scenario 1): expected exactly 1 PENDING MANUAL follow-up, got %', v_count;
  end if;

  select status into v_automatic_task.status from public.follow_up_tasks where id = v_automatic_task.id;
  if v_automatic_task.status <> 'PENDING' then
    raise exception 'ASSERTION FAILED (Scenario 1): the AUTOMATIC follow-up must remain PENDING, untouched, while a MANUAL one exists';
  end if;

  -----------------------------------------------------------------
  -- Scenario 2: creating a SECOND MANUAL follow-up for the SAME lead —
  -- the exact ליד בדיקה-shaped scenario. The first is automatically
  -- CANCELLED/superseded (never deleted, auto_closed_reason recorded);
  -- the second becomes the single current PENDING MANUAL row; the
  -- AUTOMATIC row is still completely untouched.
  -----------------------------------------------------------------
  select * into v_second_manual from public.create_manual_follow_up_for_lead(
    v_lead, 'דיברתי איתה — ביקשה שאחזור ביום ראשון אחרי 16:00', 'הקשר האנושי העדכני', now() + interval '3 days'
  );

  select * into v_old_task from public.follow_up_tasks where id = v_first_manual.id;
  if v_old_task.status <> 'CANCELLED' then
    raise exception 'ASSERTION FAILED (Scenario 2): the older MANUAL follow-up must be CANCELLED (superseded), got %', v_old_task.status;
  end if;
  if v_old_task.auto_closed_reason is null then
    raise exception 'ASSERTION FAILED (Scenario 2): the superseded MANUAL follow-up must record an auto_closed_reason';
  end if;

  if v_second_manual.status <> 'PENDING' or v_second_manual.source <> 'MANUAL' then
    raise exception 'ASSERTION FAILED (Scenario 2): the new MANUAL follow-up is not PENDING/MANUAL';
  end if;

  select count(*) into v_count
  from public.follow_up_tasks
  where lead_id = v_lead and source = 'MANUAL' and status = 'PENDING';
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (Scenario 2): expected exactly 1 PENDING MANUAL follow-up after superseding, got %', v_count;
  end if;

  select status into v_automatic_task.status from public.follow_up_tasks where id = v_automatic_task.id;
  if v_automatic_task.status <> 'PENDING' then
    raise exception 'ASSERTION FAILED (Scenario 2): the AUTOMATIC follow-up must still be untouched (PENDING) after superseding a MANUAL one';
  end if;

  -- The older MANUAL follow-up's own reminder-delivery row (created by
  -- create_follow_up_reminder_delivery() for every follow-up, any
  -- source, regardless of what happens to the task afterwards) is
  -- preserved, never deleted — full history — but the task itself being
  -- CANCELLED is what stops it ever being sent (see
  -- lib/notifications/reminder-logic.test.ts's own "superseded MANUAL
  -- follow-up ... can never send its own reminder email" test for the
  -- pure-logic side of this same guarantee).
  if not exists (
    select 1 from public.follow_up_reminder_deliveries where follow_up_task_id = v_first_manual.id
  ) then
    raise exception 'ASSERTION FAILED (Scenario 2): the superseded follow-up''s reminder-delivery row must still exist (history preserved)';
  end if;

  -----------------------------------------------------------------
  -- Scenario 3: at most one PENDING MANUAL follow-up per lead, ever —
  -- the partial unique index blocks a second one even via a direct
  -- insert that bypasses create_manual_follow_up_for_lead entirely
  -- (same defense-in-depth proof style as
  -- automatic_lead_followup_escalation.test.sql's own Scenario 3 for
  -- the AUTOMATIC-per-lead index). This is what makes the invariant
  -- hold even against a hypothetical future bug or a direct
  -- service-role write, not merely "the RPC happens to behave" —
  -- concurrent CALLS THROUGH THE RPC are additionally serialized by its
  -- own `select ... for update` lock on the lead row (inspectable in
  -- the function's own source; not independently re-provable inside a
  -- single-connection test like this one).
  -----------------------------------------------------------------
  begin
    insert into public.follow_up_tasks (lead_id, title, due_at, status, source)
      values (v_lead, 'Second concurrent-ish manual (should be blocked)', now(), 'PENDING', 'MANUAL');
    raise exception 'ASSERTION FAILED (Scenario 3): the partial unique index did not block a second PENDING MANUAL follow-up for the same lead';
  exception when unique_violation then
    null; -- expected
  end;

  -----------------------------------------------------------------
  -- Scenario 4: create_manual_follow_up_for_lead rejects a
  -- non-existent/inaccessible lead rather than silently doing nothing.
  -----------------------------------------------------------------
  begin
    perform public.create_manual_follow_up_for_lead(
      '00000000-0000-0000-0000-000000000000'::uuid, 'Should fail', null, now()
    );
    raise exception 'ASSERTION FAILED (Scenario 4): expected an exception for a non-existent lead';
  exception when others then
    if sqlerrm not like '%not found or not accessible%' then
      raise exception 'ASSERTION FAILED (Scenario 4): unexpected error message: %', sqlerrm;
    end if;
  end;

  -----------------------------------------------------------------
  -- Scenario 5: WON still auto-cancels EVERYTHING still PENDING for the
  -- lead (both the AUTOMATIC row and the current MANUAL row) — this
  -- pre-existing behavior (convert_lead_to_won/change_lead_stage,
  -- already covered end-to-end in
  -- automatic_lead_followup_escalation.test.sql's own Scenario 4) must
  -- remain completely unaffected by this migration.
  -----------------------------------------------------------------
  perform public.change_lead_stage(v_lead, 'LOST', 'NOT_INTERESTED');

  select count(*) into v_count
  from public.follow_up_tasks
  where lead_id = v_lead and status = 'PENDING';
  if v_count <> 0 then
    raise exception 'ASSERTION FAILED (Scenario 5): LOST must leave zero PENDING follow-ups for the lead, got %', v_count;
  end if;

  raise notice 'ALL ASSERTIONS PASSED';
end $$;

select 'ALL ASSERTIONS PASSED' as result;

rollback;
