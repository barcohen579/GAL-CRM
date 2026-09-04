-- Regression test for recurring business expenses
-- (supabase/migrations/20260904090000_..._recurring_business_expenses.sql).
--
-- Same style as the project's other RPC/function regression tests: a
-- self-contained, ASSERTION-BASED (RAISEs on the first mismatch),
-- BEGIN/ROLLBACK script. Never leaves real rows behind — matches the
-- task's own "use rollback fixtures / automated tests for write
-- testing, never fake Production expenses" requirement.
--
-- Run with:
--   npx supabase db query --linked -f supabase/tests/recurring_business_expenses.test.sql
--
-- A clean run prints only a final "ALL ASSERTIONS PASSED" row and
-- leaves the database completely unchanged (ROLLBACK at the end). All
-- dates are computed relative to current_date, never hardcoded.

begin;

select set_config(
  'request.jwt.claims',
  json_build_object('sub', (select auth_user_id::text from public.app_users where is_active limit 1))::text,
  true
) as _ignore;

do $$
declare
  v_onetime_id uuid;
  v_re_id uuid;
  v_re2_id uuid;
  v_rpc_result record;
  v_count int;
  v_row record;
  v_this_month date := date_trunc('month', current_date)::date;
  v_next_month date := (date_trunc('month', current_date) + interval '1 month')::date;
  v_three_months_ago date := (date_trunc('month', current_date) - interval '3 months')::date;
  v_two_months_ago date := (date_trunc('month', current_date) - interval '2 months')::date;
  v_one_month_ago date := (date_trunc('month', current_date) - interval '1 month')::date;
  v_meta_count_before int;
  v_meta_count_after int;
begin
  -----------------------------------------------------------------
  -- Scenario 1: a ONE_TIME expense (no recurring_expense_id at all —
  -- the pre-existing, unchanged shape) appears only in its own month,
  -- exactly like business_expenses.test.sql's own Scenario 3, and is
  -- correctly identifiable as "not recurring" (recurring_expense_id
  -- is null, occurrence_month is null).
  -----------------------------------------------------------------
  insert into public.business_expenses (expense_date, amount_minor, category, description)
    values (v_this_month, 25000, 'EQUIPMENT', 'Test one-time dumbbell set')
    returning id into v_onetime_id;

  select * into v_row from public.business_expenses where id = v_onetime_id;
  if v_row.recurring_expense_id is not null or v_row.occurrence_month is not null then
    raise exception 'ASSERTION FAILED (Scenario 1): a one-time expense unexpectedly has recurring fields set';
  end if;
  select count(*) into v_count
  from public.business_expenses
  where id = v_onetime_id and expense_date >= v_two_months_ago and expense_date < v_this_month;
  if v_count <> 0 then
    raise exception 'ASSERTION FAILED (Scenario 1): a this-month expense leaked into an earlier month''s query';
  end if;

  -----------------------------------------------------------------
  -- Scenario 2: create_recurring_business_expense() atomically creates
  -- the recurring definition AND its first month's occurrence,
  -- starting THIS month (next_occurrence_date lands on next month).
  -----------------------------------------------------------------
  select * into v_rpc_result from public.create_recurring_business_expense(
    'Test Studio Rent', 'RENT', 300000, v_this_month
  );
  v_re_id := v_rpc_result.recurring_expense_id;

  if (select status from public.business_recurring_expenses where id = v_re_id) <> 'ACTIVE' then
    raise exception 'ASSERTION FAILED (Scenario 2): new recurring expense not ACTIVE';
  end if;
  if (select next_occurrence_date from public.business_recurring_expenses where id = v_re_id) <> v_next_month then
    raise exception 'ASSERTION FAILED (Scenario 2): next_occurrence_date not advanced to next month after the first (manual) occurrence';
  end if;
  select * into v_row from public.business_expenses where id = v_rpc_result.expense_id;
  if v_row.amount_minor <> 300000 or v_row.occurrence_month <> v_this_month or v_row.recurring_expense_id <> v_re_id then
    raise exception 'ASSERTION FAILED (Scenario 2): first occurrence row not correctly linked/dated/amounted';
  end if;
  if v_row.is_auto_generated is not false then
    raise exception 'ASSERTION FAILED (Scenario 2): the manually-recorded first occurrence was marked is_auto_generated';
  end if;

  -----------------------------------------------------------------
  -- Scenario 3: idempotency — running the generator 5 times in a row
  -- for a purchase not yet due (next_occurrence_date is next month)
  -- must not generate anything early.
  -----------------------------------------------------------------
  for i in 1..5 loop
    perform public.generate_due_recurring_business_expenses();
  end loop;
  select count(*) into v_count from public.business_expenses where recurring_expense_id = v_re_id;
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (Scenario 3): a not-yet-due recurring expense generated an early occurrence (got % rows)', v_count;
  end if;

  -----------------------------------------------------------------
  -- Scenario 4 + 5: catch-up backfill + no-duplication. A SECOND
  -- recurring expense whose next_occurrence_date is 3 months in the
  -- past must, in ONE run, deterministically backfill every missed
  -- month exactly once — not just the latest one — and running the
  -- generator again afterward must not duplicate any of them.
  -----------------------------------------------------------------
  insert into public.business_recurring_expenses (
    description, category, amount_minor, start_date, status, next_occurrence_date
  ) values (
    'Test Software Subscription', 'SOFTWARE_SUBSCRIPTIONS', 10000, v_three_months_ago, 'ACTIVE', v_three_months_ago
  ) returning id into v_re2_id;

  perform public.generate_due_recurring_business_expenses();

  select count(*) into v_count from public.business_expenses where recurring_expense_id = v_re2_id;
  if v_count <> 4 then -- 3 months ago, 2 months ago, 1 month ago, this month
    raise exception 'ASSERTION FAILED (Scenario 4): expected 4 backfilled occurrences, got %', v_count;
  end if;
  if exists (
    select 1 from public.business_expenses
    where recurring_expense_id = v_re2_id and expense_date <> occurrence_month
  ) then
    raise exception 'ASSERTION FAILED (Scenario 4): a backfilled occurrence''s expense_date did not match its own occurrence_month';
  end if;
  if exists (
    select 1 from public.business_expenses where recurring_expense_id = v_re2_id and amount_minor <> 10000
  ) then
    raise exception 'ASSERTION FAILED (Scenario 4): a backfilled occurrence used the wrong amount';
  end if;

  perform public.generate_due_recurring_business_expenses();
  select count(*) into v_count from public.business_expenses where recurring_expense_id = v_re2_id;
  if v_count <> 4 then
    raise exception 'ASSERTION FAILED (Scenario 5): catch-up duplicated an occurrence on re-run, got %', v_count;
  end if;

  -- Same idempotency guarantee, but at the DB constraint level
  -- directly: a second row for the same (recurring_expense_id,
  -- occurrence_month) must be physically rejected, not just avoided by
  -- the generator's own care.
  begin
    insert into public.business_expenses (
      expense_date, amount_minor, category, recurring_expense_id, occurrence_month, is_auto_generated
    ) values (
      v_this_month, 10000, 'SOFTWARE_SUBSCRIPTIONS', v_re2_id, v_this_month, false
    );
    raise exception 'ASSERTION FAILED (Scenario 5): the unique index did not block a true duplicate occurrence';
  exception when unique_violation then
    null; -- expected
  end;

  -----------------------------------------------------------------
  -- Scenario 6: a definition edit (amount AND description AND
  -- category — the full "עריכת הוצאה קבועה" dialog, not just price)
  -- affects only cycles generated AFTER the edit; every already-
  -- generated occurrence keeps its original, frozen values.
  --
  -- Why this needs its own recurring expense (v_re3) rather than
  -- reusing v_re/v_re2: generate_due_recurring_business_expenses()
  -- deliberately backfills EVERY due month in ONE pass using ONE
  -- snapshot of the definition (read once per call, before the loop
  -- that may generate several months) — by design, so a single run
  -- can never produce two different prices for two different months.
  -- Within one test transaction current_date never advances, so the
  -- ONLY way to observe "old definition for an earlier month, new
  -- definition for a later one" is to manually pre-record the earlier
  -- month directly (exactly as create_recurring_business_expense
  -- itself does for a real first month), THEN edit the definition,
  -- THEN let the generator fill in the remaining still-due month(s)
  -- — which it will do using the NEW definition, since it re-reads
  -- business_recurring_expenses fresh on this call.
  -----------------------------------------------------------------
  declare
    v_re3_id uuid;
    v_re3_row record;
  begin
    insert into public.business_recurring_expenses (
      description, category, amount_minor, start_date, status, next_occurrence_date
    ) values (
      'Original Desc', 'SOFTWARE_SUBSCRIPTIONS', 10000, v_two_months_ago, 'ACTIVE', v_two_months_ago
    ) returning id into v_re3_id;

    -- Manually record the OLDEST due month directly (simulating "this
    -- already happened, before the edit") — same shape
    -- create_recurring_business_expense's own first-occurrence insert
    -- uses, just done by hand here to control exactly which month is
    -- pre-occupied.
    insert into public.business_expenses (
      expense_date, amount_minor, currency, category, description,
      recurring_expense_id, occurrence_month, is_auto_generated
    ) values (
      v_two_months_ago, 10000, 'ILS', 'SOFTWARE_SUBSCRIPTIONS', 'Original Desc',
      v_re3_id, v_two_months_ago, false
    );
    update public.business_recurring_expenses set next_occurrence_date = v_one_month_ago where id = v_re3_id;

    -- Now edit the definition — amount, description, AND category.
    update public.business_recurring_expenses
    set amount_minor = 15000, description = 'Updated Desc', category = 'OTHER'
    where id = v_re3_id;

    -- Generator fills in every remaining due month (one-month-ago,
    -- this-month) using the NEW definition.
    perform public.generate_due_recurring_business_expenses();

    -- The manually-pre-recorded, OLDER month must be completely
    -- untouched by the later definition edit.
    select * into v_re3_row
    from public.business_expenses
    where recurring_expense_id = v_re3_id and occurrence_month = v_two_months_ago;
    if v_re3_row.amount_minor <> 10000 or v_re3_row.description <> 'Original Desc' or v_re3_row.category <> 'SOFTWARE_SUBSCRIPTIONS' then
      raise exception 'ASSERTION FAILED (Scenario 6): the historical (pre-edit) occurrence was rewritten — amount=%, description=%, category=%',
        v_re3_row.amount_minor, v_re3_row.description, v_re3_row.category;
    end if;

    -- The newly-generated, LATER month must use every one of the new values.
    select * into v_re3_row
    from public.business_expenses
    where recurring_expense_id = v_re3_id and occurrence_month = v_one_month_ago;
    if v_re3_row.amount_minor <> 15000 or v_re3_row.description <> 'Updated Desc' or v_re3_row.category <> 'OTHER' then
      raise exception 'ASSERTION FAILED (Scenario 6): the post-edit occurrence did not use the updated amount/description/category — amount=%, description=%, category=%',
        v_re3_row.amount_minor, v_re3_row.description, v_re3_row.category;
    end if;
  end;

  -----------------------------------------------------------------
  -- Scenario 7: stopping a recurring expense prevents future
  -- occurrences but preserves every occurrence already generated.
  -----------------------------------------------------------------
  select count(*) into v_count from public.business_expenses where recurring_expense_id = v_re2_id;
  declare v_count_before_stop int := v_count;
  begin
    update public.business_recurring_expenses
    set status = 'STOPPED', next_occurrence_date = null
    where id = v_re2_id;

    perform public.generate_due_recurring_business_expenses();
    select count(*) into v_count from public.business_expenses where recurring_expense_id = v_re2_id;
    if v_count <> v_count_before_stop then
      raise exception 'ASSERTION FAILED (Scenario 7): a stopped recurring expense generated a new occurrence';
    end if;
  end;
  if (select status from public.business_recurring_expenses where id = v_re2_id) <> 'STOPPED' then
    raise exception 'ASSERTION FAILED (Scenario 7): status did not persist as STOPPED';
  end if;
  if (select next_occurrence_date from public.business_recurring_expenses where id = v_re2_id) is not null then
    raise exception 'ASSERTION FAILED (Scenario 7): next_occurrence_date was not cleared on stop';
  end if;

  -----------------------------------------------------------------
  -- Scenario 8: Meta spend is never touched by any of this — writing
  -- or generating business expenses never inserts into, updates, or
  -- otherwise affects meta_campaign_daily_metrics in any way.
  -----------------------------------------------------------------
  select count(*) into v_meta_count_before from public.meta_campaign_daily_metrics;
  perform public.generate_due_recurring_business_expenses();
  insert into public.business_expenses (expense_date, amount_minor, category)
    values (v_this_month, 5000, 'OTHER');
  select count(*) into v_meta_count_after from public.meta_campaign_daily_metrics;
  if v_meta_count_before <> v_meta_count_after then
    raise exception 'ASSERTION FAILED (Scenario 8): business-expense activity altered meta_campaign_daily_metrics';
  end if;

  -----------------------------------------------------------------
  -- Scenario 9: total-expenses reconciliation at the raw-data level —
  -- summing business_expenses.amount_minor for the selected month (the
  -- exact query buildMonthlyMetrics/aggregateExpensesByCategory
  -- consume) must equal the sum of every individual row inserted this
  -- month within this test, none double-counted or dropped.
  -----------------------------------------------------------------
  select coalesce(sum(amount_minor), 0) into v_count
  from public.business_expenses
  where expense_date >= v_this_month and expense_date < v_next_month
    and id in (
      select id from public.business_expenses
      where recurring_expense_id in (v_re_id, v_re2_id) and occurrence_month = v_this_month
    );
  -- v_re contributed 300000 this month (Scenario 2, manual first
  -- occurrence); v_re2 contributed 10000 this month (Scenario 4/5
  -- backfill — v_re2's own definition/amount is never edited anywhere
  -- in this file; Scenario 6's definition-edit coverage uses a
  -- separate v_re3, precisely so it can't perturb this total).
  if v_count <> 310000 then
    raise exception 'ASSERTION FAILED (Scenario 9): this-month recurring-expense total did not reconcile, got %', v_count;
  end if;

  -----------------------------------------------------------------
  -- Scenario 10: no DELETE policy exists for business_recurring_expenses,
  -- for ANY role — mirrors business_expenses.test.sql's own Scenario 5
  -- exactly: a recurring expense is stopped, never destroyed.
  -----------------------------------------------------------------
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'business_recurring_expenses' and cmd = 'DELETE'
  ) then
    raise exception 'ASSERTION FAILED (Scenario 10): a DELETE policy exists on business_recurring_expenses -- must not';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'business_recurring_expenses'
      and grantee = 'authenticated' and privilege_type = 'DELETE'
  ) then
    raise exception 'ASSERTION FAILED (Scenario 10): authenticated has a DELETE grant on business_recurring_expenses -- must not';
  end if;

  -----------------------------------------------------------------
  -- Scenario 11: recurring business expenses have ZERO effect on
  -- customer billing — purchases/payments counts are unchanged by any
  -- of the activity in this test.
  -----------------------------------------------------------------
  declare
    v_purchases_before int; v_purchases_after int;
    v_payments_before int; v_payments_after int;
  begin
    select count(*) into v_purchases_before from public.purchases;
    select count(*) into v_payments_before from public.payments;

    perform public.generate_due_recurring_business_expenses();

    select count(*) into v_purchases_after from public.purchases;
    select count(*) into v_payments_after from public.payments;

    if v_purchases_before <> v_purchases_after or v_payments_before <> v_payments_after then
      raise exception 'ASSERTION FAILED (Scenario 11): recurring business-expense generation touched purchases/payments (purchases % -> %, payments % -> %)',
        v_purchases_before, v_purchases_after, v_payments_before, v_payments_after;
    end if;
  end;

  raise notice 'ALL ASSERTIONS PASSED';
end $$;

select 'ALL ASSERTIONS PASSED' as result;

rollback;
