-- Regression test for the Monthly Business Report's expense side
-- (supabase/migrations/20260903180000_..._business_expenses.sql) and
-- a handful of DB-level invariants the report's pure TS functions
-- (lib/crm/business-report.ts, lib/crm/marketing.ts) depend on being
-- true of the REAL schema/data shape, not just of synthetic test data.
--
-- Same style as the project's other regression tests: a self-
-- contained, ASSERTION-BASED (RAISEs on the first mismatch),
-- BEGIN/ROLLBACK script.
--
-- Run with:
--   npx supabase db query --linked -f supabase/tests/business_expenses.test.sql
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
  v_expense_id uuid;
  v_row record;
  v_count int;
  v_meta_count_before int;
  v_meta_count_after int;
  v_this_month_start date := date_trunc('month', current_date)::date;
  v_two_months_ago date := (date_trunc('month', current_date) - interval '2 months')::date;
  v_referrer_contact uuid;
  v_referrer_customer uuid;
  v_referred_contact uuid;
  v_referred_customer uuid;
  v_purchase uuid;
  v_direct_contact uuid;
  v_direct_customer uuid;
  v_won_lead uuid;
  v_won_contact uuid;
begin
  -----------------------------------------------------------------
  -- Scenario 1+2: insert an expense — amount stored as exact integer
  -- agorot (₪800.55 -> 80055), expense_date stored exactly as given.
  -----------------------------------------------------------------
  insert into public.business_expenses (expense_date, amount_minor, category, description)
    values (v_this_month_start, 80055, 'SOFTWARE_SUBSCRIPTIONS', 'CapCut + software')
    returning id into v_expense_id;

  select * into v_row from public.business_expenses where id = v_expense_id;
  if v_row.amount_minor <> 80055 then
    raise exception 'ASSERTION FAILED (Scenario 2): amount not stored as exact agorot integer, got %', v_row.amount_minor;
  end if;
  if v_row.expense_date <> v_this_month_start then
    raise exception 'ASSERTION FAILED (Scenario 1): expense_date not stored exactly as given';
  end if;
  if v_row.category <> 'SOFTWARE_SUBSCRIPTIONS' then
    raise exception 'ASSERTION FAILED: category not stored correctly';
  end if;

  -----------------------------------------------------------------
  -- Scenario 3: expense_date (not created_at) determines which
  -- month's report an expense belongs to. Insert an expense dated
  -- two months ago (created "now", same as every row in this test) —
  -- a query scoped to THIS month must not find it; a query scoped to
  -- two-months-ago must.
  -----------------------------------------------------------------
  declare
    v_backdated_id uuid;
  begin
    insert into public.business_expenses (expense_date, amount_minor, category)
      values (v_two_months_ago, 50000, 'RENT')
      returning id into v_backdated_id;

    if exists (
      select 1 from public.business_expenses
      where id = v_backdated_id
        and expense_date >= v_this_month_start
        and expense_date <= (date_trunc('month', current_date) + interval '1 month - 1 day')::date
    ) then
      raise exception 'ASSERTION FAILED (Scenario 3): a backdated expense leaked into the current month''s query';
    end if;
    if not exists (
      select 1 from public.business_expenses
      where id = v_backdated_id
        and expense_date >= v_two_months_ago
        and expense_date <= (v_two_months_ago + interval '1 month - 1 day')::date
    ) then
      raise exception 'ASSERTION FAILED (Scenario 3): the backdated expense was not found in ITS OWN month''s query';
    end if;
    -- created_at is "now" for this row regardless -- confirms the
    -- period assignment truly hinges on expense_date, not created_at.
    if (select date_trunc('month', created_at)::date from public.business_expenses where id = v_backdated_id) = v_two_months_ago then
      raise exception 'ASSERTION FAILED (Scenario 3): test setup invalid -- created_at should be "now", not two months ago';
    end if;
  end;

  -----------------------------------------------------------------
  -- Scenario 4: correcting/editing an expense (amount/date/category/
  -- description) is allowed -- a direct UPDATE, proportionate to this
  -- manually-entered, single-author data (see the migration's own
  -- comment for the full reasoning vs. payments' stricter model).
  -----------------------------------------------------------------
  update public.business_expenses
  set amount_minor = 90000, category = 'EQUIPMENT', description = 'תיקון תוכנה -> ציוד'
  where id = v_expense_id;

  select * into v_row from public.business_expenses where id = v_expense_id;
  if v_row.amount_minor <> 90000 or v_row.category <> 'EQUIPMENT' then
    raise exception 'ASSERTION FAILED (Scenario 4): expense correction did not apply';
  end if;
  -- (updated_at's own advancement isn't independently verifiable
  -- within a single transaction: now() is transaction-stable in
  -- Postgres, so created_at and updated_at would read identically
  -- here regardless of whether the shared set_updated_at trigger fired
  -- -- that trigger is already an established, reused function applied
  -- identically elsewhere in this schema, not new logic introduced here.)

  -----------------------------------------------------------------
  -- Scenario 5: there is no DELETE policy for business_expenses, for
  -- ANY role -- expense history can only ever be corrected, never
  -- destroyed through the app. Verified directly against pg_policies
  -- and the actual grants (the same method used elsewhere in this
  -- project to confirm a table's real authorization shape), not by
  -- attempting a DELETE as this script's own connection (which is a
  -- privileged/owner role that bypasses RLS and grants entirely, so a
  -- DELETE here would misleadingly succeed regardless of what's
  -- actually granted to `authenticated`).
  -----------------------------------------------------------------
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'business_expenses' and cmd = 'DELETE'
  ) then
    raise exception 'ASSERTION FAILED (Scenario 5): a DELETE policy exists on business_expenses -- must not';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'business_expenses'
      and grantee = 'authenticated' and privilege_type = 'DELETE'
  ) then
    raise exception 'ASSERTION FAILED (Scenario 5): authenticated has a DELETE grant on business_expenses -- must not';
  end if;

  -----------------------------------------------------------------
  -- Scenario 6: Meta spend is never duplicated into business_expenses
  -- -- the two tables are fully independent; writing to one never
  -- touches the other (there is no trigger/shared-write-path between
  -- them at all -- this asserts that stays true).
  -----------------------------------------------------------------
  select count(*) into v_meta_count_before from public.meta_campaign_daily_metrics;
  insert into public.business_expenses (expense_date, amount_minor, category)
    values (v_this_month_start, 12345, 'MARKETING_OTHER');
  select count(*) into v_meta_count_after from public.meta_campaign_daily_metrics;
  if v_meta_count_before <> v_meta_count_after then
    raise exception 'ASSERTION FAILED (Scenario 6): inserting a business expense altered meta_campaign_daily_metrics';
  end if;

  -----------------------------------------------------------------
  -- Scenario 7: WON metric uses correct stage-event semantics --
  -- a lead_stage_events row with to_stage = 'WON' inside the month
  -- bounds is found by exactly the query shape the report uses,
  -- and is NOT found by an adjacent month's bounds.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test Report WON Contact') returning id into v_won_contact;
  insert into public.leads (contact_id) values (v_won_contact) returning id into v_won_lead;
  insert into public.lead_stage_events (lead_id, from_stage, to_stage, changed_at)
    values (v_won_lead, 'INTERESTED', 'WON', now());

  select count(*) into v_count
  from public.lead_stage_events
  where to_stage = 'WON' and lead_id = v_won_lead
    and changed_at >= date_trunc('month', current_date)
    and changed_at < date_trunc('month', current_date) + interval '1 month';
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (Scenario 7): WON stage event not found by this-month bounds';
  end if;

  select count(*) into v_count
  from public.lead_stage_events
  where to_stage = 'WON' and lead_id = v_won_lead
    and changed_at >= date_trunc('month', current_date) - interval '1 month'
    and changed_at < date_trunc('month', current_date);
  if v_count <> 0 then
    raise exception 'ASSERTION FAILED (Scenario 7): WON stage event incorrectly found by the WRONG month''s bounds';
  end if;

  -----------------------------------------------------------------
  -- Scenario 8: a direct customer (create_customer_directly, no Lead
  -- at all) is correctly discoverable as a "new customer this month"
  -- via customers.customer_since -- never via any Lead-based query,
  -- since none exists for her.
  -----------------------------------------------------------------
  select * into v_row from public.create_customer_directly(
    null, 'Test Report Direct Customer', '0508887777', null, null,
    'PERSONAL_TRAINING', null, null, 30000, 'ONE_TIME', v_this_month_start,
    null, null, null, null
  );
  v_direct_contact := v_row.contact_id;
  v_direct_customer := v_row.customer_id;

  if exists (select 1 from public.leads where contact_id = v_direct_contact) then
    raise exception 'ASSERTION FAILED (Scenario 8): a direct customer unexpectedly has a Lead';
  end if;
  select count(*) into v_count
  from public.customers
  where id = v_direct_customer
    and customer_since >= v_this_month_start
    and customer_since <= (date_trunc('month', current_date) + interval '1 month - 1 day')::date;
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (Scenario 8): direct customer not found by the "new customers this month" query';
  end if;

  -----------------------------------------------------------------
  -- Scenario 9: referral-generated revenue, end to end -- a referrer
  -- customer, a referred contact who becomes a customer via a
  -- separate direct-customer flow, and a PAID payment this month.
  -- Confirms the exact relational path
  -- referrals -> customers -> purchases -> payments the report's
  -- queries walk actually resolves correctly against real data.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test Report Referrer') returning id into v_referrer_contact;
  insert into public.customers (contact_id) values (v_referrer_contact) returning id into v_referrer_customer;

  select * into v_row from public.create_customer_directly(
    null, 'Test Report Referred Customer', '0507776666', null, null,
    'GROUP_TRAINING', null, null, 35000, 'ONE_TIME', v_this_month_start,
    35000, v_this_month_start, 'CASH', null, v_referrer_customer
  );
  v_referred_contact := v_row.contact_id;
  v_referred_customer := v_row.customer_id;
  v_purchase := v_row.purchase_id;

  if not exists (
    select 1 from public.referrals
    where referred_contact_id = v_referred_contact and referrer_customer_id = v_referrer_customer
  ) then
    raise exception 'ASSERTION FAILED (Scenario 9): referral row was not created';
  end if;

  -- The exact join path the dashboard's paymentsInMonthWithServiceRes
  -- query relies on: payment -> purchase -> customer_id, then
  -- customer_id -> (via referrals+contacts) confirmed as referred.
  select p.amount into v_row
  from public.payments p
  join public.purchases pu on pu.id = p.purchase_id
  where pu.customer_id = v_referred_customer
    and p.status = 'PAID'
    and p.paid_at >= v_this_month_start
    and p.paid_at <= (date_trunc('month', current_date) + interval '1 month - 1 day')::date;
  if v_row.amount <> 35000 then
    raise exception 'ASSERTION FAILED (Scenario 9): referred customer''s payment not found via the report''s own join path';
  end if;

  raise notice 'ALL ASSERTIONS PASSED';
end $$;

select 'ALL ASSERTIONS PASSED' as result;

rollback;
