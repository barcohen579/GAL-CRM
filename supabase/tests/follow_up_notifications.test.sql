-- Regression test for follow-up notification delivery tracking
-- (supabase/migrations/20260904150000_..._follow_up_notifications.sql).
--
-- Same style as the project's other RPC/function regression tests: a
-- self-contained, ASSERTION-BASED (RAISEs on the first mismatch),
-- BEGIN/ROLLBACK script. Never sends a real email (this file only
-- exercises DB state — claim/idempotency — never the email provider)
-- and never leaves real rows behind.
--
-- Run with:
--   npx supabase db query --linked -f supabase/tests/follow_up_notifications.test.sql
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
  v_task uuid;
  v_delivery_id uuid;
  v_count int;
  v_row record;
  v_claim record;
  v_today date := current_date;
  v_leads_before int; v_leads_after int;
  v_customers_before int; v_customers_after int;
  v_payments_before int; v_payments_after int;
begin
  -----------------------------------------------------------------
  -- Scenario 1: creating a follow_up_tasks row auto-creates a PENDING
  -- follow_up_reminder_deliveries row via the trigger — "pending" is a
  -- real, always-present state for every follow-up, not merely "no
  -- row exists yet".
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test Notification Lead') returning id into v_contact;
  insert into public.leads (contact_id) values (v_contact) returning id into v_lead;
  insert into public.follow_up_tasks (lead_id, title, due_at, status)
    values (v_lead, 'Test follow-up', now() - interval '1 hour', 'PENDING')
    returning id into v_task;

  select count(*) into v_count from public.follow_up_reminder_deliveries where follow_up_task_id = v_task;
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (Scenario 1): expected exactly 1 auto-created delivery row, got %', v_count;
  end if;

  select * into v_row from public.follow_up_reminder_deliveries where follow_up_task_id = v_task;
  v_delivery_id := v_row.id;
  if v_row.status <> 'PENDING' then
    raise exception 'ASSERTION FAILED (Scenario 1): auto-created delivery row is not PENDING, got %', v_row.status;
  end if;
  if v_row.attempt_count <> 0 then
    raise exception 'ASSERTION FAILED (Scenario 1): auto-created delivery row has nonzero attempt_count';
  end if;

  -----------------------------------------------------------------
  -- Scenario 2: unique constraint — a follow-up task can never have
  -- more than one delivery row.
  -----------------------------------------------------------------
  begin
    insert into public.follow_up_reminder_deliveries (follow_up_task_id, status)
      values (v_task, 'PENDING');
    raise exception 'ASSERTION FAILED (Scenario 2): the unique constraint did not block a second delivery row for the same task';
  exception when unique_violation then
    null; -- expected
  end;

  -----------------------------------------------------------------
  -- Scenario 3: the atomic claim pattern the cron route uses — a
  -- conditional UPDATE ... WHERE status IN ('PENDING','FAILED')
  -- RETURNING id. First claim succeeds; a second, concurrent-style
  -- claim attempt against the now-SENDING row returns zero rows.
  -----------------------------------------------------------------
  update public.follow_up_reminder_deliveries
  set status = 'SENDING', attempt_count = attempt_count + 1, last_attempted_at = now()
  where id = v_delivery_id and status in ('PENDING', 'FAILED')
  returning id into v_claim;
  if v_claim is null then
    raise exception 'ASSERTION FAILED (Scenario 3): first claim attempt unexpectedly failed';
  end if;

  update public.follow_up_reminder_deliveries
  set status = 'SENDING', attempt_count = attempt_count + 1, last_attempted_at = now()
  where id = v_delivery_id and status in ('PENDING', 'FAILED')
  returning id into v_claim;
  if v_claim is not null then
    raise exception 'ASSERTION FAILED (Scenario 3): a SECOND concurrent claim of an already-SENDING row incorrectly succeeded';
  end if;

  select attempt_count into v_count from public.follow_up_reminder_deliveries where id = v_delivery_id;
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (Scenario 3): attempt_count should be exactly 1 (only the first claim should have incremented it), got %', v_count;
  end if;

  -----------------------------------------------------------------
  -- Scenario 4: after a delivery is marked SENT, no further claim can
  -- ever succeed again — the actual DB-level "no duplicate send"
  -- guarantee.
  -----------------------------------------------------------------
  update public.follow_up_reminder_deliveries
  set status = 'SENT', sent_at = now(), provider_message_id = 'test_msg_123'
  where id = v_delivery_id;

  update public.follow_up_reminder_deliveries
  set status = 'SENDING', attempt_count = attempt_count + 1, last_attempted_at = now()
  where id = v_delivery_id and status in ('PENDING', 'FAILED')
  returning id into v_claim;
  if v_claim is not null then
    raise exception 'ASSERTION FAILED (Scenario 4): a claim attempt against an already-SENT row incorrectly succeeded';
  end if;

  -----------------------------------------------------------------
  -- Scenario 5: claim_daily_digest_send() — first call for a given
  -- date creates and claims the row; a second call the same
  -- "day" while the first is still SENDING (mid-flight) claims
  -- nothing.
  -----------------------------------------------------------------
  select * into v_row from public.claim_daily_digest_send(v_today, 5);
  if v_row.claimed_id is null then
    raise exception 'ASSERTION FAILED (Scenario 5): first claim_daily_digest_send call for a new date did not claim';
  end if;

  select * into v_claim from public.claim_daily_digest_send(v_today, 5);
  if v_claim.claimed_id is not null then
    raise exception 'ASSERTION FAILED (Scenario 5): a second claim while the first is still SENDING incorrectly succeeded';
  end if;

  -----------------------------------------------------------------
  -- Scenario 6: once marked SENT, claim_daily_digest_send never
  -- reclaims that date again (no duplicate digest the same day).
  -----------------------------------------------------------------
  update public.daily_digest_deliveries
  set status = 'SENT', sent_at = now(), provider_message_id = 'test_digest_msg', follow_up_count = 2
  where digest_date = v_today;

  select * into v_claim from public.claim_daily_digest_send(v_today, 5);
  if v_claim.claimed_id is not null then
    raise exception 'ASSERTION FAILED (Scenario 6): claim_daily_digest_send reclaimed an already-SENT date';
  end if;

  -----------------------------------------------------------------
  -- Scenario 7: SKIPPED_EMPTY is also a terminal state — never
  -- reclaimed later the same day.
  -----------------------------------------------------------------
  declare
    v_empty_date date := v_today - interval '10 days';
    v_empty_claim record;
  begin
    select * into v_row from public.claim_daily_digest_send(v_empty_date, 5);
    if v_row.claimed_id is null then
      raise exception 'ASSERTION FAILED (Scenario 7): setup claim for a fresh date failed';
    end if;
    update public.daily_digest_deliveries set status = 'SKIPPED_EMPTY', follow_up_count = 0 where digest_date = v_empty_date;

    select * into v_empty_claim from public.claim_daily_digest_send(v_empty_date, 5);
    if v_empty_claim.claimed_id is not null then
      raise exception 'ASSERTION FAILED (Scenario 7): claim_daily_digest_send reclaimed an already-SKIPPED_EMPTY date';
    end if;
  end;

  -----------------------------------------------------------------
  -- Scenario 8: a FAILED digest attempt CAN be reclaimed for retry
  -- (up to the max-attempts bound), unlike SENT/SKIPPED_EMPTY.
  -----------------------------------------------------------------
  declare
    v_retry_date date := v_today - interval '11 days';
    v_retry_claim record;
  begin
    select * into v_row from public.claim_daily_digest_send(v_retry_date, 5);
    update public.daily_digest_deliveries set status = 'FAILED', last_error = 'test failure' where digest_date = v_retry_date;

    select * into v_retry_claim from public.claim_daily_digest_send(v_retry_date, 5);
    if v_retry_claim.claimed_id is null then
      raise exception 'ASSERTION FAILED (Scenario 8): a FAILED digest was not reclaimable for retry';
    end if;
    select attempt_count into v_count from public.daily_digest_deliveries where digest_date = v_retry_date;
    if v_count <> 2 then
      raise exception 'ASSERTION FAILED (Scenario 8): attempt_count did not advance to 2 on retry, got %', v_count;
    end if;
  end;

  -----------------------------------------------------------------
  -- Scenario 9: exhausting max attempts stops further reclaiming.
  -----------------------------------------------------------------
  declare
    v_exhaust_date date := v_today - interval '12 days';
    v_exhaust_claim record;
  begin
    -- p_max_attempts = 1: the very first claim already sets attempt_count = 1.
    select * into v_row from public.claim_daily_digest_send(v_exhaust_date, 1);
    if v_row.claimed_id is null then
      raise exception 'ASSERTION FAILED (Scenario 9): setup claim failed';
    end if;
    update public.daily_digest_deliveries set status = 'FAILED', last_error = 'test failure' where digest_date = v_exhaust_date;

    select * into v_exhaust_claim from public.claim_daily_digest_send(v_exhaust_date, 1);
    if v_exhaust_claim.claimed_id is not null then
      raise exception 'ASSERTION FAILED (Scenario 9): a FAILED digest already at max_attempts was incorrectly reclaimed';
    end if;
  end;

  -----------------------------------------------------------------
  -- Scenario 10: no DELETE policy exists for either new table, for
  -- ANY role — mirrors business_expenses.test.sql's own Scenario 5.
  -----------------------------------------------------------------
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename in ('follow_up_reminder_deliveries', 'daily_digest_deliveries')
      and cmd = 'DELETE'
  ) then
    raise exception 'ASSERTION FAILED (Scenario 10): a DELETE policy exists on a notification table -- must not';
  end if;
  -- REFERENCES/TRIGGER/TRUNCATE are a project-wide baseline grant to
  -- `authenticated`/`anon` on EVERY table in this schema (confirmed
  -- live: app_users/leads/payments all carry the identical baseline,
  -- none of them touched by this migration) — inert in practice, since
  -- PostgREST (the only way `authenticated` ever reaches Postgres in
  -- this app) never issues TRUNCATE/REFERENCES/TRIGGER, only
  -- SELECT/INSERT/UPDATE/DELETE. What actually matters, and must be
  -- absent here exactly like business_expenses.test.sql's own
  -- Scenario 5 checks, is any OPERATIONAL grant.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ('follow_up_reminder_deliveries', 'daily_digest_deliveries')
      and grantee = 'authenticated'
      and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'ASSERTION FAILED (Scenario 10): `authenticated` has an operational (SELECT/INSERT/UPDATE/DELETE) grant on a notification table -- must have none';
  end if;

  -----------------------------------------------------------------
  -- Scenario 11: completing/cancelling a follow-up never touches its
  -- delivery row's own status (the cron's join-based filter on the
  -- LIVE task status is what actually prevents sending it, per this
  -- migration's own documented design choice) — confirms that
  -- documented behavior stays true.
  -----------------------------------------------------------------
  declare
    v_task2 uuid;
    v_delivery2_status public.follow_up_reminder_status;
  begin
    insert into public.follow_up_tasks (lead_id, title, due_at, status)
      values (v_lead, 'Test follow-up 2', now() - interval '1 hour', 'PENDING')
      returning id into v_task2;

    update public.follow_up_tasks set status = 'COMPLETED', completed_at = now() where id = v_task2;

    select status into v_delivery2_status from public.follow_up_reminder_deliveries where follow_up_task_id = v_task2;
    if v_delivery2_status <> 'PENDING' then
      raise exception 'ASSERTION FAILED (Scenario 11): completing a task unexpectedly changed its delivery row''s own status (documented as NOT happening — the join filter is what matters)';
    end if;
  end;

  -----------------------------------------------------------------
  -- Scenario 12: zero effect on customers/leads/purchases/payments/
  -- referrals — this feature only ever touches follow_up_tasks (read-
  -- only from the cron's perspective) and its own two new tables.
  -----------------------------------------------------------------
  select count(*) into v_leads_before from public.leads;
  select count(*) into v_customers_before from public.customers;
  select count(*) into v_payments_before from public.payments;

  perform public.claim_daily_digest_send((v_today - interval '20 days')::date, 5);

  select count(*) into v_leads_after from public.leads;
  select count(*) into v_customers_after from public.customers;
  select count(*) into v_payments_after from public.payments;

  if v_leads_before <> v_leads_after then
    raise exception 'ASSERTION FAILED (Scenario 12): claim_daily_digest_send touched leads (before % after %)', v_leads_before, v_leads_after;
  end if;
  if v_customers_before <> v_customers_after then
    raise exception 'ASSERTION FAILED (Scenario 12): claim_daily_digest_send touched customers (before % after %)', v_customers_before, v_customers_after;
  end if;
  if v_payments_before <> v_payments_after then
    raise exception 'ASSERTION FAILED (Scenario 12): claim_daily_digest_send touched payments (before % after %)', v_payments_before, v_payments_after;
  end if;

  raise notice 'ALL ASSERTIONS PASSED';
end $$;

select 'ALL ASSERTIONS PASSED' as result;

rollback;
