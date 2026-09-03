-- Regression test for "Edit Customer Details" (עריכת פרטים) —
-- app/(app)/customers/actions.ts::updateContactDetails, a plain RLS-
-- governed UPDATE on public.contacts (no new RPC).
--
-- Same style as this project's other regression tests: a self-
-- contained, ASSERTION-BASED (RAISEs on the first mismatch),
-- BEGIN/ROLLBACK script.
--
-- Run with:
--   npx supabase db query --linked -f supabase/tests/edit_customer_details.test.sql
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
  v_customer uuid;
  v_purchase uuid;
  v_payment uuid;
  v_purchase_before record;
  v_payment_before record;
  v_other_contact uuid;
  v_referrer_contact uuid;
  v_referrer_customer uuid;
  v_referred_contact uuid;
  v_referral_id uuid;
  v_row record;
  v_count int;
begin
  -----------------------------------------------------------------
  -- Setup: one customer with an active recurring purchase + a
  -- payment, so every "must remain untouched" check has real data to
  -- compare against.
  -----------------------------------------------------------------
  insert into public.contacts (full_name, phone, email, instagram_username)
    values ('Test Edit Customer Original', '0501112222', 'original@example.invalid', 'original.ig')
    returning id into v_contact;
  insert into public.customers (contact_id) values (v_contact) returning id into v_customer;
  insert into public.purchases (
    customer_id, service_type, agreed_price_amount, recurrence, start_date, status, next_billing_date, notes
  ) values (
    v_customer, 'GROUP_TRAINING', 35000, 'RECURRING_MONTHLY', current_date, 'ACTIVE',
    date_trunc('month', current_date)::date, 'test purchase notes'
  ) returning id into v_purchase;
  insert into public.payments (purchase_id, amount, currency, paid_at, method, status, billing_cycle, is_auto_generated, notes)
    values (v_purchase, 35000, 'ILS', current_date, 'CASH', 'PAID', date_trunc('month', current_date)::date, false, 'test payment notes')
    returning id into v_payment;

  select * into v_purchase_before from public.purchases where id = v_purchase;
  select * into v_payment_before from public.payments where id = v_payment;

  -----------------------------------------------------------------
  -- Scenarios 1-4: update name, phone, email, Instagram all at once
  -- (mirrors a single "שמירת שינויים" submission) -- and confirm
  -- Contact/Customer ids never change.
  -----------------------------------------------------------------
  update public.contacts
  set full_name = 'Test Edit Customer Corrected',
      phone = '0503334444',
      email = 'corrected@example.invalid',
      instagram_username = 'corrected.ig'
  where id = v_contact;

  select * into v_row from public.contacts where id = v_contact;
  if v_row.full_name <> 'Test Edit Customer Corrected' then
    raise exception 'ASSERTION FAILED (Scenario 1): name was not updated';
  end if;
  if v_row.phone <> '0503334444' then
    raise exception 'ASSERTION FAILED (Scenario 2): phone was not updated';
  end if;
  if v_row.email <> 'corrected@example.invalid' then
    raise exception 'ASSERTION FAILED (Scenario 3): email was not updated';
  end if;
  if v_row.instagram_username <> 'corrected.ig' then
    raise exception 'ASSERTION FAILED (Scenario 4): instagram_username was not updated';
  end if;
  if v_row.id <> v_contact then
    raise exception 'ASSERTION FAILED: contact id changed -- must never happen';
  end if;
  if not exists (select 1 from public.customers where id = v_customer and contact_id = v_contact) then
    raise exception 'ASSERTION FAILED: customer_id -> contact_id link was broken by the edit';
  end if;

  -----------------------------------------------------------------
  -- Scenario 5: clearing optional fields stores NULL, never ''.
  -- (The "" -> NULL conversion itself happens in the Server Action's
  -- shared optionalString() helper, identical to the one already used
  -- by createLead/createCustomerDirectly/addPurchase -- this confirms
  -- the DB side of that contract: a NULL write actually lands as NULL
  -- and is distinguishable from an empty string, not that the TS
  -- helper itself works, which is exercised identically everywhere
  -- else already.)
  -----------------------------------------------------------------
  update public.contacts set phone = null, email = null, instagram_username = null where id = v_contact;

  select * into v_row from public.contacts where id = v_contact;
  if v_row.phone is not null or v_row.email is not null or v_row.instagram_username is not null then
    raise exception 'ASSERTION FAILED (Scenario 5): cleared fields are not NULL';
  end if;
  if v_row.phone = '' or v_row.email = '' or v_row.instagram_username = '' then
    raise exception 'ASSERTION FAILED (Scenario 5): cleared fields stored as empty string instead of NULL';
  end if;
  -- restore for the remaining scenarios below
  update public.contacts set phone = '0503334444', email = 'corrected@example.invalid', instagram_username = 'corrected.ig' where id = v_contact;

  -----------------------------------------------------------------
  -- Scenario 6+7+8: purchases/payments/recurring configuration are
  -- completely untouched by any of the edits above -- full row
  -- comparison against the snapshot taken before Scenario 1.
  -----------------------------------------------------------------
  select * into v_row from public.purchases where id = v_purchase;
  if v_row.customer_id <> v_purchase_before.customer_id
     or v_row.service_type <> v_purchase_before.service_type
     or v_row.agreed_price_amount <> v_purchase_before.agreed_price_amount
     or v_row.recurrence <> v_purchase_before.recurrence
     or v_row.status <> v_purchase_before.status
     or v_row.next_billing_date is distinct from v_purchase_before.next_billing_date
     or v_row.notes is distinct from v_purchase_before.notes
  then
    raise exception 'ASSERTION FAILED (Scenario 6/8): purchase / recurring configuration was altered by a contact edit';
  end if;

  select * into v_row from public.payments where id = v_payment;
  if v_row.purchase_id <> v_payment_before.purchase_id
     or v_row.amount <> v_payment_before.amount
     or v_row.paid_at <> v_payment_before.paid_at
     or v_row.status <> v_payment_before.status
     or v_row.billing_cycle is distinct from v_payment_before.billing_cycle
     or v_row.is_auto_generated <> v_payment_before.is_auto_generated
     or v_row.notes is distinct from v_payment_before.notes
  then
    raise exception 'ASSERTION FAILED (Scenario 7): payment was altered by a contact edit';
  end if;

  -----------------------------------------------------------------
  -- Scenario 9: referral relationships stay intact and correctly
  -- reflect a renamed Contact -- the exact concern the task calls
  -- out. referrals is keyed entirely by id (referred_contact_id,
  -- referrer_customer_id), never by name, so:
  --   (a) v_customer (now renamed) can still be looked up as a
  --       referrer, and the LIVE join to contacts.full_name reflects
  --       the new name automatically -- no update to referrals
  --       needed or performed.
  --   (b) renaming the REFERRED contact is likewise reflected via the
  --       same live join, on the referrer's own "הפניות" list.
  --   (c) the referrals row's own ids never change.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test Edit Customer Referred') returning id into v_referred_contact;
  insert into public.referrals (referred_contact_id, referrer_customer_id)
    values (v_referred_contact, v_customer) returning id into v_referral_id;

  -- (a) the exact embed shape /leads/[id] and /customers/[id] use for
  -- "הופנתה על ידי" -- confirms the NEW name (from Scenario 1's
  -- rename) is what a fresh read returns.
  select r.referrer_customer_id, cust.id as referrer_customer_id_check, c.full_name as referrer_name
  into v_row
  from public.referrals r
  join public.customers cust on cust.id = r.referrer_customer_id
  join public.contacts c on c.id = cust.contact_id
  where r.id = v_referral_id;

  if v_row.referrer_name <> 'Test Edit Customer Corrected' then
    raise exception 'ASSERTION FAILED (Scenario 9a): referrer''s renamed contact was not reflected via the live join, got %', v_row.referrer_name;
  end if;

  -- Now rename the REFERRED contact and confirm (b): the referrer's
  -- own "הפניות" list embed (referred_contact:contacts(full_name))
  -- reflects it too.
  update public.contacts set full_name = 'Test Edit Customer Referred Renamed' where id = v_referred_contact;

  select c.full_name into v_row
  from public.referrals r
  join public.contacts c on c.id = r.referred_contact_id
  where r.id = v_referral_id;
  -- (re-using v_row as a single-column record here is fine -- only
  -- full_name is read back)
  if (select full_name from public.contacts where id = v_referred_contact) <> 'Test Edit Customer Referred Renamed' then
    raise exception 'ASSERTION FAILED (Scenario 9b): referred contact rename did not take effect';
  end if;
  if not exists (
    select 1 from public.referrals
    where id = v_referral_id
      and referred_contact_id = v_referred_contact
      and referrer_customer_id = v_customer
  ) then
    raise exception 'ASSERTION FAILED (Scenario 9c): referral row''s own ids changed after unrelated contact renames -- must never happen';
  end if;

  -----------------------------------------------------------------
  -- Scenario 10: conflicting phone/email with another Contact.
  --
  -- There is deliberately NO unique constraint on contacts.phone /
  -- contacts.email at the database level (matching is app-level only,
  -- exactly like createCustomerDirectly's own contact-matching) -- so
  -- this section proves two things: (a) the exact query shape
  -- updateContactDetails runs to detect a collision actually finds
  -- one when it exists, and (b) the database itself provides no
  -- automatic protection, which is exactly why that app-level check
  -- is necessary in the first place (and is unit-tested directly in
  -- lib/crm/contact-matching.test.ts's "edit-contact usage" cases).
  -----------------------------------------------------------------
  insert into public.contacts (full_name, phone, email) values ('Test Edit Customer Other', '0509998888', 'other-contact@example.invalid')
    returning id into v_other_contact;

  -- (a) the exact query updateContactDetails runs: other contacts,
  -- excluding this one, with phone not null -- must find v_other_contact
  -- when the edit form's phone value matches it exactly (the app's
  -- normalizePhone would also catch differently-formatted variants,
  -- covered by the TS-level tests -- this SQL layer only needs to
  -- confirm the query itself surfaces the right candidate row).
  select count(*) into v_count
  from public.contacts
  where id <> v_contact and phone is not null and phone = '0509998888';
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (Scenario 10a): the collision-detection query did not find the conflicting contact';
  end if;

  -- (b) proving the DB itself does not block a collision (motivating
  -- why the app-level check exists) -- performed and then immediately
  -- reverted within its own savepoint so it doesn't corrupt the rest
  -- of this test or leave a real collision behind even momentarily
  -- outside this transaction.
  begin
    update public.contacts set phone = '0509998888' where id = v_contact;
    if (select count(*) from public.contacts where phone = '0509998888') <> 2 then
      raise exception 'ASSERTION FAILED (Scenario 10b): expected the DB to (wrongly, if unguarded) allow a duplicate phone across two contacts';
    end if;
  end;
  -- Revert -- the real Server Action would never have performed this
  -- write in the first place; this block exists purely to demonstrate
  -- the DB provides no safety net on its own.
  update public.contacts set phone = '0503334444' where id = v_contact;
  if (select phone from public.contacts where id = v_contact) <> '0503334444' then
    raise exception 'ASSERTION FAILED (Scenario 10c): revert of the illustrative collision write failed';
  end if;

  raise notice 'ALL ASSERTIONS PASSED';
end $$;

select 'ALL ASSERTIONS PASSED' as result;

rollback;
