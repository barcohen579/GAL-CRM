-- Regression test for automatic monthly recurring services & payments
-- (supabase/migrations/20260903150000_..._recurring_billing_schema.sql,
-- supabase/migrations/20260903150200_..._recurring_billing_generator.sql).
--
-- Same style as the project's other RPC/function regression tests: a
-- self-contained, ASSERTION-BASED (RAISEs on the first mismatch),
-- BEGIN/ROLLBACK script.
--
-- Run with:
--   npx supabase db query --linked -f supabase/tests/recurring_billing.test.sql
--
-- A clean run prints only a final "ALL ASSERTIONS PASSED" row and
-- leaves the database completely unchanged (ROLLBACK at the end). All
-- dates are computed relative to current_date, never hardcoded, so
-- this test is valid no matter when it's run.

begin;

select set_config(
  'request.jwt.claims',
  json_build_object('sub', (select auth_user_id::text from public.app_users where is_active limit 1))::text,
  true
) as _ignore;

do $$
declare
  v_contact uuid;
  v_customer uuid;
  v_purchase_recurring uuid;
  v_purchase_onetime uuid;
  v_purchase_second uuid;
  v_this_month date := date_trunc('month', current_date)::date;
  v_next_month date := (date_trunc('month', current_date) + interval '1 month')::date;
  v_month_after_next date := (date_trunc('month', current_date) + interval '2 months')::date;
  v_three_months_ago date := (date_trunc('month', current_date) - interval '3 months')::date;
  v_count int;
  v_row record;
  v_generated_count int;
  v_leads_before int; v_leads_after int;
  v_touchpoints_before int; v_touchpoints_after int;
  v_referrals_before int; v_referrals_after int;
begin
  -----------------------------------------------------------------
  -- Setup: one customer, an ACTIVE RECURRING_MONTHLY purchase due
  -- THIS month (next_billing_date = this month's 1st -- simulating a
  -- purchase whose first cycle hasn't been generated/paid yet).
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test Recurring Sapir') returning id into v_contact;
  insert into public.customers (contact_id) values (v_contact) returning id into v_customer;
  insert into public.purchases (
    customer_id, service_type, agreed_price_amount, recurrence, start_date, status, next_billing_date
  ) values (
    v_customer, 'GROUP_TRAINING', 35000, 'RECURRING_MONTHLY', v_this_month, 'ACTIVE', v_this_month
  ) returning id into v_purchase_recurring;

  -----------------------------------------------------------------
  -- Scenario 1: generates the due cycle. Scenario 2/3: repeated /
  -- "concurrent" execution stays idempotent -- run the generator FIVE
  -- times total; exactly one payment must exist throughout.
  -----------------------------------------------------------------
  for i in 1..5 loop
    perform public.generate_due_recurring_payments();
  end loop;

  select count(*) into v_count from public.payments where purchase_id = v_purchase_recurring;
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (Scenario 1-3): expected exactly 1 payment after 5 runs, got %', v_count;
  end if;

  select * into v_row from public.payments where purchase_id = v_purchase_recurring;
  if v_row.amount <> 35000 then
    raise exception 'ASSERTION FAILED (Scenario 1): wrong amount, got %', v_row.amount;
  end if;
  if v_row.status <> 'PAID' then
    raise exception 'ASSERTION FAILED (Scenario 1): expected status PAID, got %', v_row.status;
  end if;
  if v_row.is_auto_generated is not true then
    raise exception 'ASSERTION FAILED (Scenario 1): expected is_auto_generated = true';
  end if;
  if v_row.billing_cycle <> v_this_month then
    raise exception 'ASSERTION FAILED (Scenario 1): expected billing_cycle = %, got %', v_this_month, v_row.billing_cycle;
  end if;
  -- Scenario 10: paid_at is the CYCLE's date, not "today" (they're the
  -- same in this scenario since the cycle is due this month, but this
  -- pins the invariant the missed-months scenario below actually tests).
  if v_row.paid_at <> v_this_month then
    raise exception 'ASSERTION FAILED (Scenario 10): expected paid_at = %, got %', v_this_month, v_row.paid_at;
  end if;

  -- next_billing_date correctly advanced to next month, not stuck.
  if (select next_billing_date from public.purchases where id = v_purchase_recurring) <> v_next_month then
    raise exception 'ASSERTION FAILED: next_billing_date did not advance correctly';
  end if;

  -- Scenario 4: same customer, same purchase -- no new Customer/Lead
  -- was ever created by any of this (payments has no customer_id of
  -- its own; verified via the purchase it belongs to).
  if (
    select pu.customer_id from public.payments pay
    join public.purchases pu on pu.id = pay.purchase_id
    where pay.purchase_id = v_purchase_recurring
  ) <> v_customer then
    raise exception 'ASSERTION FAILED (Scenario 4): payment not correctly linked, wrong customer';
  end if;
  select count(*) into v_count from public.customers where contact_id = v_contact;
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (Scenario 4): expected exactly 1 customer, got %', v_count;
  end if;

  -- Not due yet: running again now must not generate November's cycle early.
  perform public.generate_due_recurring_payments();
  select count(*) into v_count from public.payments where purchase_id = v_purchase_recurring;
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED: a future cycle was generated before it was due (got % payments)', v_count;
  end if;

  -----------------------------------------------------------------
  -- Scenario 5: a ONE_TIME purchase never auto-renews, even with a
  -- (deliberately invalid per the CHECK constraint, so this also
  -- confirms the DB itself refuses such a row) next_billing_date.
  -----------------------------------------------------------------
  insert into public.purchases (customer_id, service_type, agreed_price_amount, recurrence, start_date, status)
    values (v_customer, 'PERSONAL_TRAINING', 20000, 'ONE_TIME', v_this_month, 'ACTIVE')
    returning id into v_purchase_onetime;

  begin
    update public.purchases set next_billing_date = v_this_month where id = v_purchase_onetime;
    raise exception 'ASSERTION FAILED (Scenario 5): DB allowed next_billing_date on a ONE_TIME purchase';
  exception when check_violation then
    null; -- expected
  end;

  perform public.generate_due_recurring_payments();
  select count(*) into v_count from public.payments where purchase_id = v_purchase_onetime;
  if v_count <> 0 then
    raise exception 'ASSERTION FAILED (Scenario 5): a ONE_TIME purchase got an auto-generated payment';
  end if;

  -----------------------------------------------------------------
  -- Scenario 6 + 7: stopping recurring billing (the actions migration
  -- performs this exact update from the UI) blocks all FUTURE
  -- generation, but the payment already generated above survives
  -- untouched.
  -----------------------------------------------------------------
  update public.purchases
  set status = 'CANCELLED', next_billing_date = null
  where id = v_purchase_recurring;

  perform public.generate_due_recurring_payments();
  select count(*) into v_count from public.payments where purchase_id = v_purchase_recurring;
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (Scenario 6): a stopped recurring purchase generated a new payment';
  end if;
  if not exists (select 1 from public.payments where purchase_id = v_purchase_recurring and billing_cycle = v_this_month and amount = 35000) then
    raise exception 'ASSERTION FAILED (Scenario 7): the original payment was lost/altered after stopping';
  end if;

  -----------------------------------------------------------------
  -- Scenario 8: missed scheduler run / catch-up. A SECOND recurring
  -- purchase whose next_billing_date is 3 months in the past (as if
  -- the job hadn't run since then) must, in ONE run, deterministically
  -- backfill every missed month exactly once each -- not just the
  -- latest one, and with each payment's paid_at correctly landing in
  -- ITS OWN month (not all stamped "today").
  -----------------------------------------------------------------
  insert into public.purchases (
    customer_id, service_type, agreed_price_amount, recurrence, start_date, status, next_billing_date
  ) values (
    v_customer, 'NUTRITION_COACHING', 20000, 'RECURRING_MONTHLY', v_three_months_ago, 'ACTIVE', v_three_months_ago
  ) returning id into v_purchase_second;

  perform public.generate_due_recurring_payments();

  select count(*) into v_count from public.payments where purchase_id = v_purchase_second;
  if v_count <> 4 then -- 3 months ago, 2 months ago, 1 month ago, and this month
    raise exception 'ASSERTION FAILED (Scenario 8): expected 4 backfilled cycles, got %', v_count;
  end if;
  if exists (
    select 1 from public.payments
    where purchase_id = v_purchase_second and paid_at <> billing_cycle
  ) then
    raise exception 'ASSERTION FAILED (Scenario 8): a backfilled payment''s paid_at did not match its own billing_cycle';
  end if;
  -- Idempotency holds for the multi-cycle catch-up case too.
  perform public.generate_due_recurring_payments();
  select count(*) into v_count from public.payments where purchase_id = v_purchase_second;
  if v_count <> 4 then
    raise exception 'ASSERTION FAILED (Scenario 8): catch-up duplicated a cycle on re-run, got %', v_count;
  end if;

  -----------------------------------------------------------------
  -- Scenario 9: a manually-recorded first payment for the CURRENT
  -- cycle of a NEW recurring purchase must not be duplicated by the
  -- job -- exactly the "first payment recorded immediately at signup"
  -- flow the Add Customer/Add Service actions perform.
  -----------------------------------------------------------------
  declare
    v_purchase_manual_first uuid;
  begin
    insert into public.purchases (
      customer_id, service_type, agreed_price_amount, recurrence, start_date, status, next_billing_date
    ) values (
      v_customer, 'ONLINE_COACHING', 25000, 'RECURRING_MONTHLY', v_this_month, 'ACTIVE', v_next_month
    ) returning id into v_purchase_manual_first;

    insert into public.payments (purchase_id, amount, currency, paid_at, method, status, billing_cycle, is_auto_generated)
      values (v_purchase_manual_first, 25000, 'ILS', v_this_month, 'CASH', 'PAID', v_this_month, false);

    perform public.generate_due_recurring_payments();
    select count(*) into v_count from public.payments where purchase_id = v_purchase_manual_first and billing_cycle = v_this_month;
    if v_count <> 1 then
      raise exception 'ASSERTION FAILED (Scenario 9): manually-recorded first payment was duplicated, got % rows for this month', v_count;
    end if;
    if (select is_auto_generated from public.payments where purchase_id = v_purchase_manual_first and billing_cycle = v_this_month) is not false then
      raise exception 'ASSERTION FAILED (Scenario 9): the manual payment was overwritten/replaced by an auto one';
    end if;
    -- Next month's cycle is untouched (not due yet).
    select count(*) into v_count from public.payments where purchase_id = v_purchase_manual_first;
    if v_count <> 1 then
      raise exception 'ASSERTION FAILED (Scenario 9): an extra, not-yet-due payment was created, got % total', v_count;
    end if;
  end;

  -----------------------------------------------------------------
  -- Scenario 11 + 12: "did not pay this month" correction. Flipping
  -- an auto-generated payment's status PAID -> FAILED must succeed
  -- (prevent_payment_fact_changes allows status changes), must NOT
  -- touch amount/paid_at/purchase_id/billing_cycle (append-only
  -- financial facts), and must NOT stop future recurrence -- the
  -- purchase stays ACTIVE with an intact next_billing_date, and the
  -- NEXT cycle still generates normally on the next run.
  -----------------------------------------------------------------
  update public.payments
  set status = 'FAILED', notes = 'לא שילמה החודש'
  where purchase_id = v_purchase_second and billing_cycle = v_this_month;

  if (select status from public.payments where purchase_id = v_purchase_second and billing_cycle = v_this_month) <> 'FAILED' then
    raise exception 'ASSERTION FAILED (Scenario 11): status correction did not apply';
  end if;
  if (select amount from public.payments where purchase_id = v_purchase_second and billing_cycle = v_this_month) <> 20000 then
    raise exception 'ASSERTION FAILED (Scenario 11): amount was altered by the correction -- financial fact must be immutable';
  end if;
  -- Effective (PAID-only) revenue for this purchase's current cycle
  -- month no longer includes the corrected payment.
  select coalesce(sum(amount), 0) into v_count
  from public.payments
  where purchase_id = v_purchase_second and billing_cycle = v_this_month and status = 'PAID';
  if v_count <> 0 then
    raise exception 'ASSERTION FAILED (Scenario 11): corrected payment still counts toward PAID revenue';
  end if;

  if (select status from public.purchases where id = v_purchase_second) <> 'ACTIVE' then
    raise exception 'ASSERTION FAILED (Scenario 12): "did not pay" incorrectly stopped/altered the purchase status';
  end if;
  update public.purchases set next_billing_date = v_next_month where id = v_purchase_second; -- advance past "today" for a clean re-check below
  perform public.generate_due_recurring_payments();
  select count(*) into v_count from public.payments where purchase_id = v_purchase_second and billing_cycle = v_this_month;
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (Scenario 12): the FAILED cycle got regenerated -- billing_cycle uniqueness must hold regardless of status';
  end if;

  -----------------------------------------------------------------
  -- Scenario 13: price change affects only future cycles. Raise the
  -- price on v_purchase_second, then advance to next month's cycle --
  -- the OLD payment keeps its original (frozen) amount; the NEW one
  -- uses the new price.
  -----------------------------------------------------------------
  update public.purchases set agreed_price_amount = 25000 where id = v_purchase_second; -- was 20000
  update public.purchases set next_billing_date = v_next_month where id = v_purchase_second;
  perform public.generate_due_recurring_payments();

  if (select amount from public.payments where purchase_id = v_purchase_second and billing_cycle = v_next_month) <> 25000 then
    raise exception 'ASSERTION FAILED (Scenario 13): the new cycle did not use the updated price';
  end if;
  -- The three older cycles (three-months-ago .. one-month-ago) must all
  -- still show the ORIGINAL 20000 -- never rewritten by the price change.
  select count(*) into v_count
  from public.payments
  where purchase_id = v_purchase_second and billing_cycle < v_this_month and amount <> 20000;
  if v_count <> 0 then
    raise exception 'ASSERTION FAILED (Scenario 13): a historical payment''s amount was rewritten by the price change';
  end if;

  -----------------------------------------------------------------
  -- Scenario 14: multiple recurring services for the SAME customer
  -- work independently -- v_purchase_second and v_purchase_manual_first
  -- (both belong to v_customer) must each carry their own,
  -- non-interfering payment history by now.
  -----------------------------------------------------------------
  select count(distinct purchase_id) into v_count
  from public.payments p
  join public.purchases pu on pu.id = p.purchase_id
  where pu.customer_id = v_customer and p.is_auto_generated;
  if v_count < 2 then
    raise exception 'ASSERTION FAILED (Scenario 14): expected at least 2 independently-billed purchases for this customer, got %', v_count;
  end if;

  -----------------------------------------------------------------
  -- Scenario 15: recurring billing has ZERO effect on lead / touchpoint
  -- / referral counts -- it only ever touches purchases/payments.
  -----------------------------------------------------------------
  select count(*) into v_leads_before from public.leads;
  select count(*) into v_touchpoints_before from public.touchpoints;
  select count(*) into v_referrals_before from public.referrals;

  perform public.generate_due_recurring_payments();

  select count(*) into v_leads_after from public.leads;
  select count(*) into v_touchpoints_after from public.touchpoints;
  select count(*) into v_referrals_after from public.referrals;

  if v_leads_before <> v_leads_after or v_touchpoints_before <> v_touchpoints_after or v_referrals_before <> v_referrals_after then
    raise exception 'ASSERTION FAILED (Scenario 15): recurring billing changed lead/touchpoint/referral counts (leads % -> %, touchpoints % -> %, referrals % -> %)',
      v_leads_before, v_leads_after, v_touchpoints_before, v_touchpoints_after, v_referrals_before, v_referrals_after;
  end if;

  -----------------------------------------------------------------
  -- Scenario 16: create_customer_directly's own recurring-billing
  -- wiring (the "הוספת לקוחה" flow, when a monthly recurring service
  -- is chosen with an immediate first payment). Confirms: the new
  -- purchase's next_billing_date is exactly what was passed (already
  -- normalized to next month by the caller, mirroring
  -- app/(app)/customers/actions.ts), the first payment's billing_cycle
  -- occupies THIS month, and a subsequent generator run does not
  -- duplicate that first cycle -- only ever produces the following one.
  -----------------------------------------------------------------
  declare
    v_rpc_result record;
  begin
    select * into v_rpc_result from public.create_customer_directly(
      null, 'Test Recurring RPC Customer', '0507778888', null, null,
      'GROUP_TRAINING', null, null, 35000, 'RECURRING_MONTHLY', v_this_month,
      35000, v_this_month, 'BIT', null, null, v_next_month
    );

    if (select next_billing_date from public.purchases where id = v_rpc_result.purchase_id) <> v_next_month then
      raise exception 'ASSERTION FAILED (Scenario 16): next_billing_date not set correctly by create_customer_directly';
    end if;
    if (select billing_cycle from public.payments where id = v_rpc_result.payment_id) <> v_this_month then
      raise exception 'ASSERTION FAILED (Scenario 16): first payment''s billing_cycle not set correctly';
    end if;
    if (select is_auto_generated from public.payments where id = v_rpc_result.payment_id) is not false then
      raise exception 'ASSERTION FAILED (Scenario 16): the manually-recorded first payment was marked is_auto_generated';
    end if;

    perform public.generate_due_recurring_payments();
    select count(*) into v_count from public.payments where purchase_id = v_rpc_result.purchase_id;
    if v_count <> 1 then
      raise exception 'ASSERTION FAILED (Scenario 16): generator duplicated the manually-recorded first cycle (got % payments, next_billing_date was in the future so nothing should have generated)', v_count;
    end if;
  end;

  raise notice 'ALL ASSERTIONS PASSED';
end $$;

select 'ALL ASSERTIONS PASSED' as result;

rollback;
