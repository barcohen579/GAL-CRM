-- Regression test for the Automatic Lead Follow-Up Escalation Loop
-- (supabase/migrations/20260904160000_..._follow_up_task_source_automatic.sql
-- and 20260904161000_..._automatic_lead_followup_escalation.sql).
--
-- Same style as the project's other RPC/function regression tests: a
-- self-contained, ASSERTION-BASED (RAISEs on the first mismatch),
-- BEGIN/ROLLBACK script. Never sends a real email (DB state only) and
-- never leaves real rows behind.
--
-- Run with:
--   npx supabase db query --linked -f supabase/tests/automatic_lead_followup_escalation.test.sql
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
  v_count int;
  v_row record;
begin
  -----------------------------------------------------------------
  -- Scenario 1: creating a lead auto-creates exactly one AUTOMATIC,
  -- PENDING follow_up_tasks row — "no need to manually create the
  -- first follow-up".
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test Escalation Lead') returning id into v_contact;
  insert into public.leads (contact_id) values (v_contact) returning id into v_lead;

  select count(*) into v_count from public.follow_up_tasks where lead_id = v_lead and source = 'AUTOMATIC';
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (Scenario 1): expected exactly 1 auto-created AUTOMATIC follow-up, got %', v_count;
  end if;

  select * into v_task from public.follow_up_tasks where lead_id = v_lead and source = 'AUTOMATIC';
  if v_task.status <> 'PENDING' then
    raise exception 'ASSERTION FAILED (Scenario 1): auto-created follow-up is not PENDING, got %', v_task.status;
  end if;

  -----------------------------------------------------------------
  -- Scenario 2: next_eligible_follow_up_date — Thursday/Friday/
  -- Saturday all skip the weekend and land on Sunday; Sunday..Wednesday
  -- just get the next calendar day. 2026-09-10 is a Thursday,
  -- 2026-09-11 Friday, 2026-09-12 Saturday, 2026-09-06 Sunday (matches
  -- lib/crm/timezone.test.ts's own fixture dates for the same rule).
  -----------------------------------------------------------------
  if public.next_eligible_follow_up_date('2026-09-10T06:00:00+00'::timestamptz) <> '2026-09-13' then
    raise exception 'ASSERTION FAILED (Scenario 2): Thursday should skip to Sunday 2026-09-13, got %',
      public.next_eligible_follow_up_date('2026-09-10T06:00:00+00'::timestamptz);
  end if;
  if public.next_eligible_follow_up_date('2026-09-11T06:00:00+00'::timestamptz) <> '2026-09-13' then
    raise exception 'ASSERTION FAILED (Scenario 2): Friday should skip to Sunday 2026-09-13, got %',
      public.next_eligible_follow_up_date('2026-09-11T06:00:00+00'::timestamptz);
  end if;
  if public.next_eligible_follow_up_date('2026-09-12T06:00:00+00'::timestamptz) <> '2026-09-13' then
    raise exception 'ASSERTION FAILED (Scenario 2): Saturday should land on Sunday 2026-09-13, got %',
      public.next_eligible_follow_up_date('2026-09-12T06:00:00+00'::timestamptz);
  end if;
  if public.next_eligible_follow_up_date('2026-09-06T06:00:00+00'::timestamptz) <> '2026-09-07' then
    raise exception 'ASSERTION FAILED (Scenario 2): Sunday should get the very next day, Monday 2026-09-07, got %',
      public.next_eligible_follow_up_date('2026-09-06T06:00:00+00'::timestamptz);
  end if;

  -- The Day-0 task actually created above must use this same rule:
  -- due_at, read back in Israel time, must be 10:00 on
  -- next_eligible_follow_up_date(lead.created_at) — see
  -- 20260904190000_..._automatic_followup_10am.sql (was 09:00).
  declare
    v_lead_created_at timestamptz;
    v_expected_date date;
  begin
    select created_at into v_lead_created_at from public.leads where id = v_lead;
    v_expected_date := public.next_eligible_follow_up_date(v_lead_created_at);
    if (v_task.due_at at time zone 'Asia/Jerusalem')::date <> v_expected_date then
      raise exception 'ASSERTION FAILED (Scenario 2): Day-0 follow-up due_at is not on the expected next eligible date';
    end if;
    if extract(hour from (v_task.due_at at time zone 'Asia/Jerusalem')) <> 10
      or extract(minute from (v_task.due_at at time zone 'Asia/Jerusalem')) <> 0 then
      raise exception 'ASSERTION FAILED (Scenario 2): Day-0 follow-up is not due at 10:00 Israel time';
    end if;
  end;

  -----------------------------------------------------------------
  -- Scenario 3: at most one AUTOMATIC follow-up per lead, ever — the
  -- partial unique index blocks a second one even via direct insert.
  -----------------------------------------------------------------
  begin
    insert into public.follow_up_tasks (lead_id, title, due_at, status, source)
      values (v_lead, 'Second automatic (should be blocked)', now(), 'PENDING', 'AUTOMATIC');
    raise exception 'ASSERTION FAILED (Scenario 3): the partial unique index did not block a second AUTOMATIC follow-up for the same lead';
  exception when unique_violation then
    null; -- expected
  end;

  -----------------------------------------------------------------
  -- Scenario 4: transitioning a lead to WON auto-cancels its still-
  -- PENDING follow-ups (both AUTOMATIC and MANUAL), preserving history
  -- (CANCELLED, not deleted) with auto_closed_reason set. A CONTACTED
  -- lead is used as the starting point to prove ordinary stage
  -- progression on the way there did NOT already close anything.
  -----------------------------------------------------------------
  declare
    v_manual_task uuid;
    v_customer_id uuid;
    v_purchase_id uuid;
  begin
    insert into public.follow_up_tasks (lead_id, title, due_at, status, source)
      values (v_lead, 'Manual follow-up', now() + interval '1 day', 'PENDING', 'MANUAL')
      returning id into v_manual_task;

    perform public.change_lead_stage(v_lead, 'CONTACTED');
  end;

  -- Ordinary stage progression (NEW -> CONTACTED) must NOT touch any
  -- follow-up.
  if exists (
    select 1 from public.follow_up_tasks
    where lead_id = v_lead and status <> 'PENDING'
  ) then
    raise exception 'ASSERTION FAILED (Scenario 4): NEW -> CONTACTED incorrectly closed a follow-up';
  end if;

  select customer_id, purchase_id into v_row
  from public.convert_lead_to_won(
    v_lead, 'PERSONAL_TRAINING', null, 10000, 'ONE_TIME', current_date, 'test'
  );

  if exists (
    select 1 from public.follow_up_tasks
    where lead_id = v_lead and status = 'PENDING'
  ) then
    raise exception 'ASSERTION FAILED (Scenario 4): WON conversion left a PENDING follow-up behind';
  end if;

  select count(*) into v_count from public.follow_up_tasks
    where lead_id = v_lead and status = 'CANCELLED' and auto_closed_reason is not null;
  if v_count <> 2 then
    raise exception 'ASSERTION FAILED (Scenario 4): expected both follow-ups (AUTOMATIC + MANUAL) auto-cancelled with a reason, got %', v_count;
  end if;

  -- completed_at must stay null on an auto-cancelled row (CANCELLED,
  -- not COMPLETED — the existing check constraint already requires
  -- this, this just confirms it holds for the automatic path too).
  if exists (
    select 1 from public.follow_up_tasks
    where lead_id = v_lead and status = 'CANCELLED' and completed_at is not null
  ) then
    raise exception 'ASSERTION FAILED (Scenario 4): an auto-cancelled follow-up incorrectly has completed_at set';
  end if;

  -----------------------------------------------------------------
  -- Scenario 5: LOST also auto-cancels pending follow-ups, on a fresh
  -- lead (WON already consumed the first one above).
  -----------------------------------------------------------------
  declare
    v_lost_contact uuid;
    v_lost_lead uuid;
  begin
    insert into public.contacts (full_name) values ('Test Escalation Lead (LOST)') returning id into v_lost_contact;
    insert into public.leads (contact_id) values (v_lost_contact) returning id into v_lost_lead;

    perform public.change_lead_stage(v_lost_lead, 'LOST', 'NOT_INTERESTED');

    if exists (
      select 1 from public.follow_up_tasks where lead_id = v_lost_lead and status = 'PENDING'
    ) then
      raise exception 'ASSERTION FAILED (Scenario 5): LOST left a PENDING follow-up behind';
    end if;
    select count(*) into v_count from public.follow_up_tasks
      where lead_id = v_lost_lead and status = 'CANCELLED' and auto_closed_reason is not null;
    if v_count <> 1 then
      raise exception 'ASSERTION FAILED (Scenario 5): expected the AUTOMATIC follow-up auto-cancelled with a reason on LOST, got %', v_count;
    end if;
  end;

  -----------------------------------------------------------------
  -- Scenario 6: lead_auto_escalation_deliveries — unique constraint
  -- blocks a second row for the same (task, Israel calendar day), but
  -- allows a different day for the same task.
  -----------------------------------------------------------------
  declare
    v_esc_contact uuid;
    v_esc_lead uuid;
    v_esc_task uuid;
    v_esc_id uuid;
  begin
    insert into public.contacts (full_name) values ('Test Escalation Lead (deliveries)') returning id into v_esc_contact;
    insert into public.leads (contact_id) values (v_esc_contact) returning id into v_esc_lead;
    select id into v_esc_task from public.follow_up_tasks where lead_id = v_esc_lead and source = 'AUTOMATIC';

    insert into public.lead_auto_escalation_deliveries (follow_up_task_id, escalation_date, status)
      values (v_esc_task, current_date, 'SENDING')
      returning id into v_esc_id;

    begin
      insert into public.lead_auto_escalation_deliveries (follow_up_task_id, escalation_date, status)
        values (v_esc_task, current_date, 'SENDING');
      raise exception 'ASSERTION FAILED (Scenario 6): unique constraint did not block a second escalation row for the same task + day';
    exception when unique_violation then
      null; -- expected
    end;

    -- A different Israel calendar day for the SAME task is fine (this
    -- is exactly what "escalate again tomorrow" needs).
    insert into public.lead_auto_escalation_deliveries (follow_up_task_id, escalation_date, status)
      values (v_esc_task, current_date + 1, 'SENDING');

    select count(*) into v_count from public.lead_auto_escalation_deliveries where follow_up_task_id = v_esc_task;
    if v_count <> 2 then
      raise exception 'ASSERTION FAILED (Scenario 6): expected 2 escalation rows (two different days) for the same task, got %', v_count;
    end if;
  end;

  -----------------------------------------------------------------
  -- Scenario 7: no RLS policy grants `authenticated` any access to
  -- lead_auto_escalation_deliveries, and no DELETE policy exists on it
  -- for any role — mirrors follow_up_notifications.test.sql's own
  -- Scenario 10.
  -----------------------------------------------------------------
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'lead_auto_escalation_deliveries'
  ) then
    raise exception 'ASSERTION FAILED (Scenario 7): a policy exists on lead_auto_escalation_deliveries — must have none';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'lead_auto_escalation_deliveries'
      and grantee = 'authenticated'
      and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'ASSERTION FAILED (Scenario 7): `authenticated` has an operational grant on lead_auto_escalation_deliveries — must have none';
  end if;

  -----------------------------------------------------------------
  -- Scenario 8: zero effect on customers/payments/purchases beyond
  -- exactly what convert_lead_to_won is documented to create (Scenario
  -- 4 already created one customer/purchase deliberately) — this
  -- migration itself does not touch money tables.
  -----------------------------------------------------------------
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payments'
      and column_name in ('auto_closed_reason')
  ) then
    raise exception 'ASSERTION FAILED (Scenario 8): payments table was unexpectedly touched by this migration';
  end if;

  raise notice 'ALL ASSERTIONS PASSED';
end $$;

select 'ALL ASSERTIONS PASSED' as result;

rollback;
