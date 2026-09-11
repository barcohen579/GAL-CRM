-- Regression test for General (non-Customer/Purchase) manual payments
-- (supabase/migrations/20260911140000_..._general_payments.sql).
--
-- Same style as the project's other regression tests: a self-
-- contained, ASSERTION-BASED (RAISEs on the first mismatch),
-- BEGIN/ROLLBACK script.
--
-- Run with:
--   npx supabase db query --linked -f supabase/tests/general_payments.test.sql
--
-- A clean run prints only a final "ALL ASSERTIONS PASSED" row and
-- leaves the database completely unchanged (ROLLBACK at the end).

begin;

do $$
declare
  v_contact uuid;
  v_customer uuid;
  v_purchase uuid;
  v_general_payment uuid;
  v_customer_payment uuid;
  v_count int;
  v_row record;
  v_default_context text;
begin
  -----------------------------------------------------------------
  -- Setup: one real Customer + Purchase, for the CUSTOMER-shaped
  -- scenarios below.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test General Payments Contact')
    returning id into v_contact;
  insert into public.customers (contact_id) values (v_contact) returning id into v_customer;
  insert into public.purchases (customer_id, service_type, agreed_price_amount, start_date)
    values (v_customer, 'PERSONAL_TRAINING', 35000, current_date)
    returning id into v_purchase;

  -----------------------------------------------------------------
  -- Scenario 1: a GENERAL payment (no purchase_id) inserts
  -- successfully and is real PAID revenue.
  -----------------------------------------------------------------
  insert into public.payments (payment_context, purchase_id, amount, paid_at, method, status, notes)
    values ('GENERAL', null, 50000, current_date, 'CASH', 'PAID', 'סדנה חד-פעמית')
    returning id into v_general_payment;

  select * into v_row from public.payments where id = v_general_payment;
  if v_row.purchase_id is not null then
    raise exception 'ASSERTION FAILED (Scenario 1): a GENERAL payment unexpectedly has a purchase_id';
  end if;
  if v_row.payment_context <> 'GENERAL' then
    raise exception 'ASSERTION FAILED (Scenario 1): payment_context not stored as GENERAL';
  end if;
  if v_row.status <> 'PAID' then
    raise exception 'ASSERTION FAILED (Scenario 1): GENERAL payment status not stored correctly';
  end if;

  -----------------------------------------------------------------
  -- Scenario 2: a CUSTOMER payment WITHOUT a purchase_id is rejected
  -- by the shape CHECK constraint.
  -----------------------------------------------------------------
  begin
    insert into public.payments (payment_context, purchase_id, amount, paid_at, method, status)
      values ('CUSTOMER', null, 10000, current_date, 'CASH', 'PAID');
    raise exception 'ASSERTION FAILED (Scenario 2): a CUSTOMER payment without purchase_id was accepted';
  exception
    when check_violation then
      null; -- expected
  end;

  -----------------------------------------------------------------
  -- Scenario 3: a GENERAL payment WITH a purchase_id is rejected by
  -- the same shape CHECK constraint.
  -----------------------------------------------------------------
  begin
    insert into public.payments (payment_context, purchase_id, amount, paid_at, method, status, notes)
      values ('GENERAL', v_purchase, 10000, current_date, 'CASH', 'PAID', 'לא אמור להתקבל');
    raise exception 'ASSERTION FAILED (Scenario 3): a GENERAL payment with a purchase_id was accepted';
  exception
    when check_violation then
      null; -- expected
  end;

  -----------------------------------------------------------------
  -- Scenario 4: a GENERAL payment with an empty/null description is
  -- rejected.
  -----------------------------------------------------------------
  begin
    insert into public.payments (payment_context, purchase_id, amount, paid_at, method, status, notes)
      values ('GENERAL', null, 10000, current_date, 'CASH', 'PAID', null);
    raise exception 'ASSERTION FAILED (Scenario 4a): a GENERAL payment with a null description was accepted';
  exception
    when check_violation then
      null; -- expected
  end;

  begin
    insert into public.payments (payment_context, purchase_id, amount, paid_at, method, status, notes)
      values ('GENERAL', null, 10000, current_date, 'CASH', 'PAID', '   ');
    raise exception 'ASSERTION FAILED (Scenario 4b): a GENERAL payment with a whitespace-only description was accepted';
  exception
    when check_violation then
      null; -- expected
  end;

  -----------------------------------------------------------------
  -- Scenario 5: prevent_payment_fact_changes still blocks changing
  -- purchase_id/payment_context after creation (extended, not
  -- weakened, by this migration).
  -----------------------------------------------------------------
  begin
    update public.payments set payment_context = 'CUSTOMER' where id = v_general_payment;
    raise exception 'ASSERTION FAILED (Scenario 5a): payment_context was changed after creation';
  exception
    when raise_exception then
      null; -- expected (the trigger's own RAISE EXCEPTION)
  end;

  insert into public.payments (payment_context, purchase_id, amount, paid_at, method, status)
    values ('CUSTOMER', v_purchase, 35000, current_date, 'CASH', 'PAID')
    returning id into v_customer_payment;

  begin
    update public.payments set purchase_id = null where id = v_customer_payment;
    raise exception 'ASSERTION FAILED (Scenario 5b): purchase_id was changed after creation';
  exception
    when raise_exception then
      null; -- expected
  end;

  -- status/notes remain freely correctable, unaffected by this migration.
  update public.payments set status = 'REFUNDED' where id = v_customer_payment;
  select status into v_row from public.payments where id = v_customer_payment;
  if v_row.status <> 'REFUNDED' then
    raise exception 'ASSERTION FAILED (Scenario 5c): status is no longer correctable after this migration';
  end if;

  -----------------------------------------------------------------
  -- Scenario 6: the GENERAL payment is retrievable via the exact
  -- LEFT JOIN shape the app's purchase:purchases(...) embed uses
  -- (app/(app)/payments/page.tsx) -- proving it's reachable with a
  -- null purchase side, not silently dropped by an inner join.
  -----------------------------------------------------------------
  select p.id, pu.customer_id into v_row
  from public.payments p
  left join public.purchases pu on pu.id = p.purchase_id
  where p.id = v_general_payment;
  if v_row.id is null then
    raise exception 'ASSERTION FAILED (Scenario 6): GENERAL payment not found via the app''s own left-join shape';
  end if;
  if v_row.customer_id is not null then
    raise exception 'ASSERTION FAILED (Scenario 6): GENERAL payment unexpectedly resolved a customer_id';
  end if;

  -----------------------------------------------------------------
  -- Scenario 7: a GENERAL payment is structurally unreachable via the
  -- Customer-history query shape (purchases -> payments nested under
  -- a specific customer_id) -- proves "never appears in Customer
  -- history" without relying on app code.
  -----------------------------------------------------------------
  select count(*) into v_count
  from public.purchases pu
  join public.payments p on p.purchase_id = pu.id
  where pu.customer_id = v_customer and p.id = v_general_payment;
  if v_count <> 0 then
    raise exception 'ASSERTION FAILED (Scenario 7): GENERAL payment leaked into a Customer-scoped purchases->payments query';
  end if;

  -----------------------------------------------------------------
  -- Scenario 8: a plain insert that never mentions payment_context
  -- (exactly how generate_due_recurring_payments() and
  -- create_customer_directly() already insert) still defaults to
  -- CUSTOMER -- confirms neither function needs to change.
  -----------------------------------------------------------------
  insert into public.payments (purchase_id, amount, paid_at, method, status)
    values (v_purchase, 1000, current_date, 'CASH', 'PAID')
    returning payment_context into v_default_context;
  if v_default_context <> 'CUSTOMER' then
    raise exception 'ASSERTION FAILED (Scenario 8): payment_context did not default to CUSTOMER';
  end if;

  -----------------------------------------------------------------
  -- Scenario 9: existing historical payments (payment_context implied
  -- by the column default, not explicitly set here) remain valid rows
  -- with a real purchase_id, exactly as before this migration.
  -----------------------------------------------------------------
  select count(*) into v_count
  from public.payments
  where purchase_id = v_purchase and payment_context = 'CUSTOMER';
  if v_count < 1 then
    raise exception 'ASSERTION FAILED (Scenario 9): existing CUSTOMER-context payments not intact';
  end if;

  raise notice 'ALL ASSERTIONS PASSED';
end $$;

select 'ALL ASSERTIONS PASSED' as result;

rollback;
