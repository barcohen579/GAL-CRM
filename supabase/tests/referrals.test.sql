-- Regression test for the referral model
-- (supabase/migrations/20260903121124_gal_crm_v1_referrals.sql,
-- supabase/migrations/20260903121212_gal_crm_v1_create_customer_directly_referral.sql).
--
-- Same style as supabase/tests/delete_lead_safely.test.sql /
-- create_customer_directly.test.sql — a self-contained, ASSERTION-BASED
-- (RAISEs on the first mismatch), BEGIN/ROLLBACK script.
--
-- Run with:
--   npx supabase db query --linked -f supabase/tests/referrals.test.sql
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
  v_referrer_contact uuid;
  v_referrer_customer uuid;
  v_referred_contact_lead uuid;
  v_lead_id uuid;
  v_referral_id uuid;
  v_result record;
  v_won_customer_id uuid;
  v_referral_count int;
  v_blocked boolean;
  v_referrer2_contact uuid;
  v_referrer2_customer uuid;
  v_referrer2_lead uuid;
  v_third_contact uuid;
begin
  -----------------------------------------------------------------
  -- Setup: a referrer who is already a real Customer.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test Referral Referrer') returning id into v_referrer_contact;
  insert into public.customers (contact_id) values (v_referrer_contact) returning id into v_referrer_customer;

  -----------------------------------------------------------------
  -- Scenario 1: Lead + REFERRAL touchpoint + valid referrer.
  -- Mirrors what app/(app)/leads/actions.ts::createLead does: create
  -- the lead + a REFERRAL touchpoint, then insert the referrals row
  -- tied to the CONTACT (never the lead).
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test Referral Lead Contact') returning id into v_referred_contact_lead;
  insert into public.leads (contact_id) values (v_referred_contact_lead) returning id into v_lead_id;
  insert into public.touchpoints (lead_id, channel, certainty, is_primary)
    values (v_lead_id, 'REFERRAL', 'CONFIRMED', true);
  insert into public.referrals (referred_contact_id, referrer_customer_id)
    values (v_referred_contact_lead, v_referrer_customer) returning id into v_referral_id;

  if (select referrer_customer_id from public.referrals where id = v_referral_id) <> v_referrer_customer then
    raise exception 'ASSERTION FAILED (Scenario 1): referrer_customer_id not stored correctly';
  end if;
  if (select channel from public.touchpoints where lead_id = v_lead_id) <> 'REFERRAL' then
    raise exception 'ASSERTION FAILED (Scenario 1): touchpoint channel is not REFERRAL';
  end if;

  -----------------------------------------------------------------
  -- Scenario 2: direct customer creation (create_customer_directly)
  -- with a referrer — no Lead is ever created, and the referral row
  -- IS created against the new contact.
  -----------------------------------------------------------------
  select * into v_result from public.create_customer_directly(
    null, 'Test Referral Direct Customer', '0503334444', null, null,
    'PERSONAL_TRAINING', null, null, 30000, 'ONE_TIME', '2026-09-03',
    null, null, null, null, v_referrer_customer
  );
  if exists (select 1 from public.leads where contact_id = v_result.contact_id) then
    raise exception 'ASSERTION FAILED (Scenario 2): a Lead was created for a direct-customer referral — must never happen';
  end if;
  if not exists (
    select 1 from public.referrals
    where referred_contact_id = v_result.contact_id and referrer_customer_id = v_referrer_customer
  ) then
    raise exception 'ASSERTION FAILED (Scenario 2): referral row was not created for the direct customer flow';
  end if;

  -----------------------------------------------------------------
  -- Scenario 3: referral survives WON conversion without duplication.
  -- convert_lead_to_won only touches leads/purchases/customers — the
  -- referrals row (keyed off contact_id, never lead_id) must remain
  -- exactly one row, unchanged, once the referred contact becomes a
  -- paying customer.
  -----------------------------------------------------------------
  select * into v_result from public.convert_lead_to_won(
    v_lead_id, 'PERSONAL_TRAINING', null, 35000, 'ONE_TIME', '2026-09-03', null
  );
  v_won_customer_id := v_result.customer_id;

  select count(*) into v_referral_count from public.referrals where referred_contact_id = v_referred_contact_lead;
  if v_referral_count <> 1 then
    raise exception 'ASSERTION FAILED (Scenario 3): expected exactly 1 referral row after WON conversion, got %', v_referral_count;
  end if;
  if (select referrer_customer_id from public.referrals where referred_contact_id = v_referred_contact_lead) <> v_referrer_customer then
    raise exception 'ASSERTION FAILED (Scenario 3): referrer_customer_id changed/lost across WON conversion';
  end if;
  if v_won_customer_id is null then
    raise exception 'ASSERTION FAILED (Scenario 3): WON conversion did not produce a customer';
  end if;

  -----------------------------------------------------------------
  -- Scenario 4: self-referral is rejected (SQLSTATE GALR1), and
  -- leaves no partial row behind.
  -----------------------------------------------------------------
  v_blocked := false;
  begin
    insert into public.referrals (referred_contact_id, referrer_customer_id)
      values (v_referrer_contact, v_referrer_customer);
  exception when sqlstate 'GALR1' then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'ASSERTION FAILED (Scenario 4): self-referral was NOT rejected';
  end if;
  if exists (select 1 from public.referrals where referred_contact_id = v_referrer_contact) then
    raise exception 'ASSERTION FAILED (Scenario 4): a self-referral row was left behind despite being rejected';
  end if;

  -----------------------------------------------------------------
  -- Scenario 5: duplicate referral is prevented — a contact can only
  -- ever have ONE referrals row (referred_contact_id is UNIQUE).
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test Referral Third Contact') returning id into v_third_contact;
  insert into public.referrals (referred_contact_id, referrer_customer_id) values (v_third_contact, v_referrer_customer);

  v_blocked := false;
  begin
    insert into public.referrals (referred_contact_id, referrer_customer_id) values (v_third_contact, v_referrer_customer);
  exception when unique_violation then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'ASSERTION FAILED (Scenario 5): a duplicate referral for the same contact was NOT rejected';
  end if;
  select count(*) into v_referral_count from public.referrals where referred_contact_id = v_third_contact;
  if v_referral_count <> 1 then
    raise exception 'ASSERTION FAILED (Scenario 5): expected exactly 1 referral row, got %', v_referral_count;
  end if;

  -----------------------------------------------------------------
  -- Scenario 6: orphan lead deletion cascades the referral. A Lead
  -- whose contact has NO customer is safely deletable via
  -- delete_lead_safely — when that contact is then orphan-deleted,
  -- its referrals row (ON DELETE CASCADE on referred_contact_id)
  -- must go with it, not linger as a dangling row. Uses a FRESH
  -- contact/lead — v_referred_contact_lead is no longer eligible: it
  -- became a real customer in Scenario 3's WON conversion.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test Referral Orphan Cascade') returning id into v_referred_contact_lead;
  insert into public.leads (contact_id) values (v_referred_contact_lead) returning id into v_lead_id;
  insert into public.touchpoints (lead_id, channel, certainty, is_primary)
    values (v_lead_id, 'REFERRAL', 'CONFIRMED', true);
  insert into public.referrals (referred_contact_id, referrer_customer_id)
    values (v_referred_contact_lead, v_referrer_customer);

  perform public.delete_lead_safely(v_lead_id);
  -- This contact has no OTHER lead and no customer -> it was
  -- orphan-deleted as part of that call, per delete_lead_safely's
  -- existing behavior (unrelated to this migration, just relied upon).
  if exists (select 1 from public.contacts where id = v_referred_contact_lead) then
    raise exception 'ASSERTION FAILED (Scenario 6): expected the referred contact to be orphan-deleted';
  end if;
  if exists (select 1 from public.referrals where referred_contact_id = v_referred_contact_lead) then
    raise exception 'ASSERTION FAILED (Scenario 6): referral row was not cascade-deleted with its contact';
  end if;

  -----------------------------------------------------------------
  -- Scenario 7: a referrer's OWN customer-linked lead cannot be
  -- deleted via delete_lead_safely (pre-existing GALB1 guard) — so a
  -- referral pointing at that customer can never be silently orphaned
  -- through lead deletion.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test Referral Referrer 2') returning id into v_referrer2_contact;
  insert into public.leads (contact_id, stage) values (v_referrer2_contact, 'WON') returning id into v_referrer2_lead;
  insert into public.customers (contact_id) values (v_referrer2_contact) returning id into v_referrer2_customer;
  insert into public.purchases (customer_id, lead_id, service_type, agreed_price_amount, start_date)
    values (v_referrer2_customer, v_referrer2_lead, 'GROUP_TRAINING', 20000, current_date);
  insert into public.referrals (referred_contact_id, referrer_customer_id) values (v_third_contact, v_referrer2_customer)
    on conflict (referred_contact_id) do update set referrer_customer_id = excluded.referrer_customer_id;
  -- (re-pointing v_third_contact's referral here is just test setup reuse; the
  -- actual assertion below is about v_referrer2_lead being undeletable)

  v_blocked := false;
  begin
    perform public.delete_lead_safely(v_referrer2_lead);
  exception when sqlstate 'GALB1' then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'ASSERTION FAILED (Scenario 7): a referrer''s own customer-linked lead was deletable';
  end if;
  if not exists (select 1 from public.customers where id = v_referrer2_customer) then
    raise exception 'ASSERTION FAILED (Scenario 7): referrer''s customer row was destroyed';
  end if;
  if not exists (select 1 from public.referrals where referrer_customer_id = v_referrer2_customer) then
    raise exception 'ASSERTION FAILED (Scenario 7): referral pointing at the referrer was lost';
  end if;

  -----------------------------------------------------------------
  -- Scenario 8: referrer page metrics — direct query shape used by
  -- /customers/[id] to compute "הפניות" counts (the JS-side
  -- aggregation itself is covered by lib/crm/referrals.test.ts;
  -- this checks the DB rows it's built from are what's expected).
  -----------------------------------------------------------------
  select count(*) into v_referral_count from public.referrals where referrer_customer_id = v_referrer_customer;
  if v_referral_count <> 2 then
    -- Scenario 1's referral (that referred contact WON-converted in
    -- Scenario 3, but the referral row survives, tied to contact_id --
    -- see Scenario 3) + Scenario 2's direct customer both remain.
    -- Scenario 6 used a SEPARATE, throwaway contact that was
    -- cascade-deleted, so it never counted here to begin with.
    raise exception 'ASSERTION FAILED (Scenario 8): expected 2 remaining referrals for the original referrer, got %', v_referral_count;
  end if;

  raise notice 'ALL ASSERTIONS PASSED';
end $$;

select 'ALL ASSERTIONS PASSED' as result;

rollback;
