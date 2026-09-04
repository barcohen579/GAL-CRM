-- Regression test for "Automatic Lead Follow-Up Always at 10:00 Next
-- Eligible Day" (see
-- supabase/migrations/20260904190000_..._automatic_followup_10am.sql
-- and its paired backfill migration
-- 20260904191000_..._automatic_followup_10am_backfill.sql).
--
-- Exercises the REAL create_automatic_followup_for_new_lead() trigger
-- directly (not the lib/crm/timezone.ts TS mirror, which has its own
-- fast, DB-free test coverage in lib/crm/timezone.test.ts for the same
-- worked examples) by inserting real leads with an explicit
-- created_at at each of the task's own example times, and reading
-- back what the trigger actually produced.
--
-- Same style as this project's other RPC/function regression tests: a
-- self-contained, ASSERTION-BASED (RAISEs on the first mismatch),
-- BEGIN/ROLLBACK script. Never sends a real email (DB state only) and
-- never leaves real rows behind.
--
-- Run with:
--   npx supabase db query --linked -f supabase/tests/automatic_followup_10am.test.sql
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
  v_task record;
begin
  -----------------------------------------------------------------
  -- Scenario 1: Sunday 08:00 Israel -> Monday 10:00 (the task's own
  -- first worked example).
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('10am Test — Sun 08:00') returning id into v_contact;
  insert into public.leads (contact_id, created_at) values (v_contact, '2026-09-06T05:00:00+00') returning id into v_lead;
  select * into v_task from public.follow_up_tasks where lead_id = v_lead and source = 'AUTOMATIC';
  if v_task.due_at <> '2026-09-07T07:00:00+00'::timestamptz then -- 2026-09-07 10:00 IDT (UTC+3)
    raise exception 'ASSERTION FAILED (Scenario 1: Sunday 08:00 -> Monday 10:00): got due_at %', v_task.due_at;
  end if;

  -----------------------------------------------------------------
  -- Scenario 2: Sunday 23:30 Israel (late night) -> still Monday
  -- 10:00, not pushed an extra day — proves the RULE is
  -- time-independent, not just the day-selection helper.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('10am Test — Sun 23:30') returning id into v_contact;
  insert into public.leads (contact_id, created_at) values (v_contact, '2026-09-06T20:30:00+00') returning id into v_lead;
  select * into v_task from public.follow_up_tasks where lead_id = v_lead and source = 'AUTOMATIC';
  if v_task.due_at <> '2026-09-07T07:00:00+00'::timestamptz then
    raise exception 'ASSERTION FAILED (Scenario 2: Sunday 23:30 -> Monday 10:00): got due_at %', v_task.due_at;
  end if;

  -----------------------------------------------------------------
  -- Scenario 3: Wednesday 17:00 Israel -> Thursday 10:00.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('10am Test — Wed 17:00') returning id into v_contact;
  insert into public.leads (contact_id, created_at) values (v_contact, '2026-09-09T14:00:00+00') returning id into v_lead;
  select * into v_task from public.follow_up_tasks where lead_id = v_lead and source = 'AUTOMATIC';
  if v_task.due_at <> '2026-09-10T07:00:00+00'::timestamptz then -- 2026-09-10 10:00 IDT
    raise exception 'ASSERTION FAILED (Scenario 3: Wednesday 17:00 -> Thursday 10:00): got due_at %', v_task.due_at;
  end if;

  -----------------------------------------------------------------
  -- Scenario 4: Thursday 22:00 Israel -> Sunday 10:00 (skips
  -- Friday/Saturday).
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('10am Test — Thu 22:00') returning id into v_contact;
  insert into public.leads (contact_id, created_at) values (v_contact, '2026-09-10T19:00:00+00') returning id into v_lead;
  select * into v_task from public.follow_up_tasks where lead_id = v_lead and source = 'AUTOMATIC';
  if v_task.due_at <> '2026-09-13T07:00:00+00'::timestamptz then -- 2026-09-13 10:00 IDT
    raise exception 'ASSERTION FAILED (Scenario 4: Thursday 22:00 -> Sunday 10:00): got due_at %', v_task.due_at;
  end if;

  -----------------------------------------------------------------
  -- Scenario 5: a Saturday lead -> Sunday 10:00.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('10am Test — Sat') returning id into v_contact;
  insert into public.leads (contact_id, created_at) values (v_contact, '2026-09-12T09:00:00+00') returning id into v_lead;
  select * into v_task from public.follow_up_tasks where lead_id = v_lead and source = 'AUTOMATIC';
  if v_task.due_at <> '2026-09-13T07:00:00+00'::timestamptz then
    raise exception 'ASSERTION FAILED (Scenario 5: Saturday -> Sunday 10:00): got due_at %', v_task.due_at;
  end if;

  -----------------------------------------------------------------
  -- Scenario 6: DST-safe across the real Israel DST-end boundary
  -- (2026-10-25) — a Thursday-evening (IDT, UTC+3) lead lands on the
  -- Sunday that is itself the DST-end day, still correctly 10:00
  -- local (IST, UTC+2) — same fixture as
  -- lib/crm/timezone.test.ts's own DST-boundary test for
  -- automaticFollowUpDueAtIso.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('10am Test — DST boundary') returning id into v_contact;
  insert into public.leads (contact_id, created_at) values (v_contact, '2026-10-22T19:00:00+00') returning id into v_lead;
  select * into v_task from public.follow_up_tasks where lead_id = v_lead and source = 'AUTOMATIC';
  if v_task.due_at <> '2026-10-25T08:00:00+00'::timestamptz then -- 2026-10-25 10:00 IST (UTC+2)
    raise exception 'ASSERTION FAILED (Scenario 6): DST-boundary due_at should be 2026-10-25T08:00:00+00 (10:00 IST), got %', v_task.due_at;
  end if;

  -----------------------------------------------------------------
  -- Scenario 7: the 10:00 rule is AUTOMATIC-only — a MANUAL follow-up
  -- Gal explicitly schedules for Monday 16:00 is stored EXACTLY as
  -- given, completely untouched by any of the above. The lead's own
  -- sibling AUTOMATIC row (created by the same trigger exercised in
  -- every scenario above, at this lead's real created_at = now()) is
  -- confirmed still exactly 10:00 on its own correct next-eligible
  -- date, proving the two never interfere with each other.
  -----------------------------------------------------------------
  declare
    v_manual public.follow_up_tasks;
    v_expected_manual_due timestamptz := '2026-09-07T13:00:00+00'; -- Monday 16:00 IDT (UTC+3)
    v_lead_created_at timestamptz;
    v_expected_automatic_date date;
  begin
    insert into public.contacts (full_name) values ('10am Test — MANUAL stays 16:00') returning id into v_contact;
    insert into public.leads (contact_id) values (v_contact) returning id into v_lead;
    select created_at into v_lead_created_at from public.leads where id = v_lead;
    v_expected_automatic_date := public.next_eligible_follow_up_date(v_lead_created_at);

    select * into v_manual from public.create_manual_follow_up_for_lead(
      v_lead, 'לחזור ביום שני אחה"צ', null, v_expected_manual_due
    );

    if v_manual.due_at <> v_expected_manual_due then
      raise exception 'ASSERTION FAILED (Scenario 7): MANUAL follow-up due_at was altered — expected %, got %',
        v_expected_manual_due, v_manual.due_at;
    end if;
    if extract(hour from (v_manual.due_at at time zone 'Asia/Jerusalem')) <> 16 then
      raise exception 'ASSERTION FAILED (Scenario 7): MANUAL follow-up is not at 16:00 Israel time as Gal chose, got %',
        extract(hour from (v_manual.due_at at time zone 'Asia/Jerusalem'));
    end if;

    select * into v_task from public.follow_up_tasks where lead_id = v_lead and source = 'AUTOMATIC';
    if (v_task.due_at at time zone 'Asia/Jerusalem')::date <> v_expected_automatic_date then
      raise exception 'ASSERTION FAILED (Scenario 7): sibling AUTOMATIC row is not on its expected date % — got %',
        v_expected_automatic_date, (v_task.due_at at time zone 'Asia/Jerusalem')::date;
    end if;
    if extract(hour from (v_task.due_at at time zone 'Asia/Jerusalem')) <> 10
      or extract(minute from (v_task.due_at at time zone 'Asia/Jerusalem')) <> 0 then
      raise exception 'ASSERTION FAILED (Scenario 7): sibling AUTOMATIC row is not 10:00 Israel time — the MANUAL creation must not have touched it';
    end if;
  end;

  raise notice 'ALL ASSERTIONS PASSED';
end $$;

select 'ALL ASSERTIONS PASSED' as result;

rollback;
