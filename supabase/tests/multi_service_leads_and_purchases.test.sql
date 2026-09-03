-- Regression test for Phase 3F: multi-service lead interest
-- (public.lead_interested_services) + multiple Purchases per Customer
-- (the "הוספת שירות" flow, plain sequential inserts in
-- app/(app)/customers/actions.ts::addPurchase — no RPC, see that
-- file's own comment for why) + WON conversion never assuming every
-- interested service was purchased.
--
-- Same self-contained, assertion-based, BEGIN/ROLLBACK style as the
-- other files in this directory. Run with:
--   npx supabase db query --linked -f supabase/tests/multi_service_leads_and_purchases.test.sql

begin;

select set_config(
  'request.jwt.claims',
  json_build_object('sub', (select auth_user_id::text from public.app_users where is_active limit 1))::text,
  true
) as _ignore;

do $$
declare
  v_contact_a uuid;
  v_lead_a uuid;
  v_result record;
  v_contact_id uuid;
  v_customer_id uuid;
  v_purchase1_id uuid;
  v_purchase2_id uuid;
  v_leads_before int;
  v_touchpoints_before int;
  v_blocked boolean;
  v_lead_multi uuid;
  v_contact_multi uuid;
begin
  -----------------------------------------------------------------
  -- 1. Lead with exactly ONE interested service.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test MultiSvc Lead A') returning id into v_contact_a;
  insert into public.leads (contact_id) values (v_contact_a) returning id into v_lead_a;
  insert into public.lead_interested_services (lead_id, service_type) values (v_lead_a, 'GROUP_TRAINING');

  if (select count(*) from public.lead_interested_services where lead_id = v_lead_a) <> 1 then
    raise exception 'ASSERTION FAILED (1): expected exactly 1 interested service';
  end if;

  -----------------------------------------------------------------
  -- 2. Lead with MULTIPLE interested services.
  -----------------------------------------------------------------
  insert into public.lead_interested_services (lead_id, service_type) values (v_lead_a, 'NUTRITION_COACHING');

  if (select count(*) from public.lead_interested_services where lead_id = v_lead_a) <> 2 then
    raise exception 'ASSERTION FAILED (2): expected exactly 2 interested services';
  end if;

  -----------------------------------------------------------------
  -- 3. No duplicate service-interest rows for the same lead/service —
  --    enforced by the (lead_id, service_type) primary key itself,
  --    not just application logic.
  -----------------------------------------------------------------
  v_blocked := false;
  begin
    insert into public.lead_interested_services (lead_id, service_type) values (v_lead_a, 'GROUP_TRAINING');
  exception when unique_violation then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'ASSERTION FAILED (3): a duplicate (lead_id, service_type) row was NOT rejected';
  end if;
  if (select count(*) from public.lead_interested_services where lead_id = v_lead_a) <> 2 then
    raise exception 'ASSERTION FAILED (3): duplicate attempt changed the row count';
  end if;

  -----------------------------------------------------------------
  -- 4-6. An existing Customer gets a second Purchase (mirrors
  -- addPurchase's plain insert): no duplicate Contact/Customer, two
  -- independent PAID payments (₪350 + ₪300 = ₪650 in agorot),
  -- historical dates preserved, and — critically — no Lead or
  -- Touchpoint is created by any of this.
  -----------------------------------------------------------------
  select count(*) into v_leads_before from public.leads;
  select count(*) into v_touchpoints_before from public.touchpoints;

  select * into v_result from public.create_customer_directly(
    null, 'Test MultiSvc Customer', '0505554433', null, null,
    'GROUP_TRAINING', null, null, 35000, 'ONE_TIME', '2026-09-01',
    35000, '2026-09-01', 'BIT', null
  );
  v_contact_id := v_result.contact_id;
  v_customer_id := v_result.customer_id;
  v_purchase1_id := v_result.purchase_id;

  -- Second purchase for the SAME customer_id — no matching/find-or-
  -- create needed, exactly like addPurchase.
  insert into public.purchases (
    customer_id, lead_id, service_type, agreed_price_amount,
    agreed_price_currency, recurrence, start_date, status
  ) values (
    v_customer_id, null, 'NUTRITION_COACHING', 30000, 'ILS', 'ONE_TIME', '2026-09-03', 'ACTIVE'
  ) returning id into v_purchase2_id;

  insert into public.payments (purchase_id, amount, currency, paid_at, method, status)
  values (v_purchase2_id, 30000, 'ILS', '2026-09-03', 'CARD', 'PAID');

  if (select count(*) from public.contacts where id = v_contact_id) <> 1 then
    raise exception 'ASSERTION FAILED (4): expected exactly one contact, no duplicate';
  end if;
  if (select count(*) from public.customers where contact_id = v_contact_id) <> 1 then
    raise exception 'ASSERTION FAILED (4): expected exactly one customer, no duplicate';
  end if;
  if (select count(*) from public.purchases where customer_id = v_customer_id) <> 2 then
    raise exception 'ASSERTION FAILED (4): expected exactly two purchases for this customer';
  end if;

  if (
    select sum(amount) from public.payments
    where purchase_id in (v_purchase1_id, v_purchase2_id) and status = 'PAID'
  ) <> 65000 then
    raise exception 'ASSERTION FAILED (5): the two payments do not sum to exactly 65000 agorot (₪650)';
  end if;
  if (select paid_at from public.payments where purchase_id = v_purchase1_id) <> '2026-09-01'::date then
    raise exception 'ASSERTION FAILED (5): first payment historical date not preserved';
  end if;
  if (select paid_at from public.payments where purchase_id = v_purchase2_id) <> '2026-09-03'::date then
    raise exception 'ASSERTION FAILED (5): second payment historical date not preserved';
  end if;

  if (select count(*) from public.leads) <> v_leads_before then
    raise exception 'ASSERTION FAILED (6): a Lead was created by adding a second purchase — must never happen';
  end if;
  if (select count(*) from public.touchpoints) <> v_touchpoints_before then
    raise exception 'ASSERTION FAILED (6): a Touchpoint was created by adding a second purchase — must never happen';
  end if;

  -----------------------------------------------------------------
  -- 7. WON conversion never assumes every interested service was
  -- purchased: a lead interested in TWO services, converted with only
  -- ONE of them, must produce exactly one Purchase — for the CHOSEN
  -- service — never both.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test MultiSvc WON Lead') returning id into v_contact_multi;
  insert into public.leads (contact_id) values (v_contact_multi) returning id into v_lead_multi;
  insert into public.lead_interested_services (lead_id, service_type)
  values (v_lead_multi, 'GROUP_TRAINING'), (v_lead_multi, 'NUTRITION_COACHING');

  select * into v_result from public.convert_lead_to_won(
    v_lead_multi, 'GROUP_TRAINING', null, 35000, 'ONE_TIME', '2026-09-03', null
  );

  if (select count(*) from public.purchases where customer_id = v_result.customer_id) <> 1 then
    raise exception 'ASSERTION FAILED (7): expected exactly ONE purchase after WON conversion, not one per interested service';
  end if;
  if (select service_type from public.purchases where id = v_result.purchase_id) <> 'GROUP_TRAINING' then
    raise exception 'ASSERTION FAILED (7): the purchase does not match the explicitly chosen service';
  end if;
  if exists (
    select 1 from public.purchases
    where customer_id = v_result.customer_id and service_type = 'NUTRITION_COACHING'
  ) then
    raise exception 'ASSERTION FAILED (7): the OTHER interested service was incorrectly auto-purchased';
  end if;
  -- The lead's interested-services record itself is untouched by
  -- conversion — both original interests remain visible on the (now
  -- WON) lead for reference.
  if (select count(*) from public.lead_interested_services where lead_id = v_lead_multi) <> 2 then
    raise exception 'ASSERTION FAILED (7): the lead''s recorded interests were altered by WON conversion';
  end if;

  raise notice 'ALL ASSERTIONS PASSED';
end $$;

select 'ALL ASSERTIONS PASSED' as result;

rollback;
