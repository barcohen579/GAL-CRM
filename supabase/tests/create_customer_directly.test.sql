-- Regression test for public.create_customer_directly(...)
-- (supabase/migrations/20260903105452_gal_crm_v1_create_customer_directly.sql).
--
-- Same style and rationale as
-- supabase/tests/delete_lead_safely.test.sql — this project's
-- automated suite (`npm test`) is TS-only, with no DB-integration
-- harness and no prior precedent of testing any RPC (change_lead_stage,
-- convert_lead_to_won, delete_lead_safely) that way either. This is a
-- self-contained, ASSERTION-BASED (RAISEs on the first mismatch),
-- BEGIN/ROLLBACK script — re-runnable against the real linked project
-- at any time with zero residue.
--
-- Run with:
--   npx supabase db query --linked -f supabase/tests/create_customer_directly.test.sql
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
  v_result record;
  v_contact_id uuid;
  v_customer_id uuid;
  v_purchase_count int;
  v_contact_count_before int;
  v_customer_count_before int;
begin
  -----------------------------------------------------------------
  -- Scenario 1: brand-new contact, service + a historical PAID
  -- payment. Confirms: no Lead/Touchpoint anywhere, agorot stored
  -- exactly, the payment date is the SELECTED (historical) date, not
  -- today, and status is PAID.
  -----------------------------------------------------------------
  select * into v_result from public.create_customer_directly(
    null, 'Test Direct Customer 1', '0501112222', null, null,
    'GROUP_TRAINING', null, null, 35000, 'ONE_TIME', '2026-08-15',
    35000, '2026-08-15', 'BIT', null
  );
  if v_result.created_new_contact is not true then
    raise exception 'ASSERTION FAILED (Scenario 1): expected created_new_contact = true';
  end if;
  if v_result.created_new_customer is not true then
    raise exception 'ASSERTION FAILED (Scenario 1): expected created_new_customer = true';
  end if;
  if v_result.payment_id is null then
    raise exception 'ASSERTION FAILED (Scenario 1): expected a payment to be created';
  end if;
  if exists (select 1 from public.purchases where id = v_result.purchase_id and lead_id is not null) then
    raise exception 'ASSERTION FAILED (Scenario 1): purchase.lead_id must be NULL — no fake lead attribution';
  end if;
  if (select amount from public.payments where id = v_result.payment_id) <> 35000 then
    raise exception 'ASSERTION FAILED (Scenario 1): payment amount not stored as exact agorot integer';
  end if;
  if (select paid_at from public.payments where id = v_result.payment_id) <> '2026-08-15'::date then
    raise exception 'ASSERTION FAILED (Scenario 1): historical payment date was not preserved';
  end if;
  if (select status from public.payments where id = v_result.payment_id) <> 'PAID' then
    raise exception 'ASSERTION FAILED (Scenario 1): payment status must be PAID';
  end if;
  if exists (select 1 from public.leads where contact_id = v_result.contact_id) then
    raise exception 'ASSERTION FAILED (Scenario 1): a Lead was created — must never happen for this flow';
  end if;
  if exists (
    select 1 from public.touchpoints t
    join public.leads l on l.id = t.lead_id
    where l.contact_id = v_result.contact_id
  ) then
    raise exception 'ASSERTION FAILED (Scenario 1): a Touchpoint was created — must never happen for this flow';
  end if;

  v_contact_id := v_result.contact_id;
  v_customer_id := v_result.customer_id;

  -----------------------------------------------------------------
  -- Scenario 2: the SAME matched contact, who already has a
  -- Customer — must reuse BOTH (duplicate-customer protection), add
  -- only a second Purchase, and create no payment when none is given.
  -----------------------------------------------------------------
  select * into v_result from public.create_customer_directly(
    v_contact_id, 'Test Direct Customer 1', null, null, null,
    'PERSONAL_TRAINING', null, null, 40000, 'ONE_TIME', '2026-09-01',
    null, null, null, null
  );
  if v_result.created_new_contact is not false then
    raise exception 'ASSERTION FAILED (Scenario 2): expected the existing contact to be reused';
  end if;
  if v_result.created_new_customer is not false then
    raise exception 'ASSERTION FAILED (Scenario 2): expected the existing customer to be reused, not duplicated';
  end if;
  if v_result.customer_id <> v_customer_id then
    raise exception 'ASSERTION FAILED (Scenario 2): a second, different customer was created';
  end if;
  if v_result.payment_id is not null then
    raise exception 'ASSERTION FAILED (Scenario 2): no payment was requested but one was created';
  end if;

  select count(*) into v_purchase_count from public.purchases where customer_id = v_customer_id;
  if v_purchase_count <> 2 then
    raise exception 'ASSERTION FAILED (Scenario 2): expected exactly 2 purchases for this customer, got %', v_purchase_count;
  end if;

  -----------------------------------------------------------------
  -- Scenario 3: OTHER service_type with no custom name — must be
  -- BLOCKED, and must leave NO partial Contact/Customer/Purchase
  -- (transaction integrity — nothing partially committed).
  -----------------------------------------------------------------
  select count(*) into v_contact_count_before from public.contacts;
  select count(*) into v_customer_count_before from public.customers;

  begin
    perform public.create_customer_directly(
      null, 'Test Direct Customer FAIL', null, null, null,
      'OTHER', null, null, 10000, 'ONE_TIME', '2026-09-03',
      null, null, null, null
    );
    raise exception 'ASSERTION FAILED (Scenario 3): OTHER without a custom name should have been rejected';
  exception when others then
    if sqlerrm not like '%Custom service name is required%' then
      raise; -- a different, unexpected error — re-raise it for visibility
    end if;
  end;

  if (select count(*) from public.contacts) <> v_contact_count_before then
    raise exception 'ASSERTION FAILED (Scenario 3): a Contact was left behind after a failed call';
  end if;
  if (select count(*) from public.customers) <> v_customer_count_before then
    raise exception 'ASSERTION FAILED (Scenario 3): a Customer was left behind after a failed call';
  end if;

  -----------------------------------------------------------------
  -- Scenario 4: OTHER service_type WITH a custom name — succeeds,
  -- and the custom name is stored correctly.
  -----------------------------------------------------------------
  select * into v_result from public.create_customer_directly(
    null, 'Test Direct Customer 4', null, 'test4@example.invalid', null,
    'OTHER', 'ליווי מיוחד', 'test purchase notes', 20000, 'ONE_TIME', '2026-09-03',
    null, null, null, null
  );
  if (select custom_service_name from public.purchases where id = v_result.purchase_id) <> 'ליווי מיוחד' then
    raise exception 'ASSERTION FAILED (Scenario 4): custom_service_name was not stored correctly';
  end if;

  raise notice 'ALL ASSERTIONS PASSED';
end $$;

select 'ALL ASSERTIONS PASSED' as result;

rollback;
