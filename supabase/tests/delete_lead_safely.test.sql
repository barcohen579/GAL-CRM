-- Regression test for public.delete_lead_safely(uuid)
-- (supabase/migrations/20260903101406_gal_crm_v1_delete_lead_safely.sql).
--
-- This project's automated test suite (`npm test`) is Node's built-in
-- test runner over TypeScript modules — there is no existing
-- DB-integration-test harness (no local Postgres/pgTAP setup, no `pg`
-- client dependency), and no other RPC in this schema
-- (change_lead_stage, convert_lead_to_won) has automated DB-level
-- tests either. This file is the equivalent for a DATABASE function:
-- a single, self-contained, ASSERTION-BASED script — it RAISEs an
-- exception (fails loudly) on the first mismatch, and does nothing
-- silent — wrapped in BEGIN/ROLLBACK so it can be re-run against the
-- real linked project at any time with zero residue, exactly like the
-- verification queries used throughout this project's incident
-- reports.
--
-- Run with:
--   npx supabase db query --linked -f supabase/tests/delete_lead_safely.test.sql
--
-- A clean run prints nothing but a final "ALL ASSERTIONS PASSED" row
-- and leaves the database completely unchanged (ROLLBACK at the end).
-- Any failed assertion raises an exception, which the CLI surfaces as
-- a query error — so "no error" is the pass signal, same as the
-- Phase 3C/3D incident-report scripts this mirrors.

begin;

-- Simulates a real authenticated CRM session for the duration of this
-- transaction only (never persisted) — delete_lead_safely() requires
-- public.is_crm_user() to be true, which reads auth.uid() from this
-- session-local JWT claims setting. Uses the one already-existing,
-- already-active app_users row rather than fabricating one (app_users
-- .auth_user_id has a NOT NULL FK to auth.users, so an arbitrary id
-- would fail regardless).
select set_config(
  'request.jwt.claims',
  json_build_object('sub', (select auth_user_id::text from public.app_users where is_active limit 1))::text,
  true
) as _ignore;

do $$
declare
  v_contact_a uuid;
  v_lead_a uuid;
  v_contact_shared uuid;
  v_lead_shared_1 uuid;
  v_lead_shared_2 uuid;
  v_contact_customer uuid;
  v_lead_customer uuid;
  v_customer_id uuid;
  v_purchase_id uuid;
  v_contact_ingest uuid;
  v_lead_ingest uuid;
  v_touchpoint_ingest uuid;
  v_ingestion_id uuid;
  v_result record;
  v_active_app_user_id uuid;
  v_blocked boolean;
begin
  -----------------------------------------------------------------
  -- Scenario 1: ordinary NEW lead — full delete, stage events /
  -- touchpoints / follow-ups cleaned up, contact orphan-deleted.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test Delete Scenario 1') returning id into v_contact_a;
  insert into public.leads (contact_id) values (v_contact_a) returning id into v_lead_a;
  insert into public.lead_stage_events (lead_id, from_stage, to_stage) values (v_lead_a, 'NEW', 'CONTACTED');
  insert into public.touchpoints (lead_id, channel, certainty, is_primary) values (v_lead_a, 'WALK_IN', 'CONFIRMED', true);
  insert into public.follow_up_tasks (lead_id, title, due_at) values (v_lead_a, 'test followup', now() + interval '1 day');

  select * into v_result from public.delete_lead_safely(v_lead_a);
  if v_result.contact_deleted is not true then
    raise exception 'ASSERTION FAILED (Scenario 1): expected contact_deleted = true, got %', v_result.contact_deleted;
  end if;
  if exists(select 1 from public.lead_stage_events where lead_id = v_lead_a) then
    raise exception 'ASSERTION FAILED (Scenario 1): lead_stage_events not cleaned up';
  end if;
  if exists(select 1 from public.touchpoints where lead_id = v_lead_a) then
    raise exception 'ASSERTION FAILED (Scenario 1): touchpoints not cleaned up';
  end if;
  if exists(select 1 from public.follow_up_tasks where lead_id = v_lead_a) then
    raise exception 'ASSERTION FAILED (Scenario 1): follow_up_tasks not cleaned up';
  end if;
  if exists(select 1 from public.leads where id = v_lead_a) then
    raise exception 'ASSERTION FAILED (Scenario 1): lead itself not deleted';
  end if;
  if exists(select 1 from public.contacts where id = v_contact_a) then
    raise exception 'ASSERTION FAILED (Scenario 1): orphan contact not deleted';
  end if;

  -----------------------------------------------------------------
  -- Scenario 2: a shared contact (two leads) — deleting one lead
  -- must NOT delete the contact, and must not touch the other lead.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test Delete Scenario 2 Shared') returning id into v_contact_shared;
  insert into public.leads (contact_id, stage) values (v_contact_shared, 'LOST') returning id into v_lead_shared_1;
  insert into public.leads (contact_id) values (v_contact_shared) returning id into v_lead_shared_2;

  select * into v_result from public.delete_lead_safely(v_lead_shared_1);
  if v_result.contact_deleted is not false then
    raise exception 'ASSERTION FAILED (Scenario 2): expected contact_deleted = false, got %', v_result.contact_deleted;
  end if;
  if not exists(select 1 from public.contacts where id = v_contact_shared) then
    raise exception 'ASSERTION FAILED (Scenario 2): shared contact was incorrectly deleted';
  end if;
  if not exists(select 1 from public.leads where id = v_lead_shared_2) then
    raise exception 'ASSERTION FAILED (Scenario 2): the OTHER lead was incorrectly affected';
  end if;
  -- cleanup so it doesn't linger for the rest of this script (still
  -- inside the same transaction, still rolled back at the very end)
  perform public.delete_lead_safely(v_lead_shared_2);

  -----------------------------------------------------------------
  -- Scenario 3: a customer-linked lead — deletion must be BLOCKED
  -- entirely (SQLSTATE GALB1), and purchases/payments must survive.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test Delete Scenario 3 Customer') returning id into v_contact_customer;
  insert into public.leads (contact_id, stage) values (v_contact_customer, 'WON') returning id into v_lead_customer;
  insert into public.customers (contact_id) values (v_contact_customer) returning id into v_customer_id;
  insert into public.purchases (customer_id, lead_id, service_type, agreed_price_amount, start_date)
    values (v_customer_id, v_lead_customer, 'PERSONAL_TRAINING', 10000, current_date) returning id into v_purchase_id;
  insert into public.payments (purchase_id, amount, paid_at, method) values (v_purchase_id, 10000, current_date, 'CASH');

  v_blocked := false;
  begin
    perform public.delete_lead_safely(v_lead_customer);
  exception when sqlstate 'GALB1' then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'ASSERTION FAILED (Scenario 3): customer-linked lead deletion was NOT blocked';
  end if;
  if not exists(select 1 from public.leads where id = v_lead_customer) then
    raise exception 'ASSERTION FAILED (Scenario 3): lead was deleted despite being blocked';
  end if;
  if not exists(select 1 from public.purchases where id = v_purchase_id) then
    raise exception 'ASSERTION FAILED (Scenario 3): purchase history was destroyed';
  end if;
  if not exists(select 1 from public.payments where purchase_id = v_purchase_id) then
    raise exception 'ASSERTION FAILED (Scenario 3): payment history was destroyed';
  end if;

  -----------------------------------------------------------------
  -- Scenario 4: meta_lead_ingestions stays schema-consistent — the
  -- ingestion audit row survives the delete, with lead_id/
  -- touchpoint_id nulled out (its own ON DELETE SET NULL FKs), never
  -- deleted itself.
  -----------------------------------------------------------------
  insert into public.contacts (full_name) values ('Test Delete Scenario 4 Ingestion') returning id into v_contact_ingest;
  insert into public.leads (contact_id) values (v_contact_ingest) returning id into v_lead_ingest;
  insert into public.touchpoints (lead_id, channel, certainty, external_ref, is_primary)
    values (v_lead_ingest, 'META_AD', 'CONFIRMED', 'test-scenario-4-leadgen-id', true) returning id into v_touchpoint_ingest;
  insert into public.meta_lead_ingestions (
    leadgen_id, meta_page_id, received_at, status, contact_id, lead_id, touchpoint_id, processed_at
  ) values (
    'test-scenario-4-leadgen-id', '000000000000000', now(), 'PROCESSED',
    v_contact_ingest, v_lead_ingest, v_touchpoint_ingest, now()
  ) returning id into v_ingestion_id;

  perform public.delete_lead_safely(v_lead_ingest);

  if not exists(select 1 from public.meta_lead_ingestions where id = v_ingestion_id) then
    raise exception 'ASSERTION FAILED (Scenario 4): ingestion audit row was deleted — it must never be';
  end if;
  select lead_id, touchpoint_id into v_lead_ingest, v_touchpoint_ingest
  from public.meta_lead_ingestions where id = v_ingestion_id;
  if v_lead_ingest is not null or v_touchpoint_ingest is not null then
    raise exception 'ASSERTION FAILED (Scenario 4): lead_id/touchpoint_id were not nulled out';
  end if;

  -----------------------------------------------------------------
  -- Scenario 5: unauthorized / inactive user — is_crm_user() must
  -- return false for a deactivated app_users row, blocking deletion.
  -----------------------------------------------------------------
  select id into v_active_app_user_id from public.app_users where is_active limit 1;
  update public.app_users set is_active = false where id = v_active_app_user_id;

  insert into public.contacts (full_name) values ('Test Delete Scenario 5 Inactive') returning id into v_contact_a;
  insert into public.leads (contact_id) values (v_contact_a) returning id into v_lead_a;

  v_blocked := false;
  begin
    perform public.delete_lead_safely(v_lead_a);
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'ASSERTION FAILED (Scenario 5): an inactive app_users session was able to delete a lead';
  end if;
  if not exists(select 1 from public.leads where id = v_lead_a) then
    raise exception 'ASSERTION FAILED (Scenario 5): lead was deleted despite an inactive session';
  end if;

  -- restore for the rest of the script / any later manual re-run in
  -- the same session (harmless either way since everything rolls back)
  update public.app_users set is_active = true where id = v_active_app_user_id;

  raise notice 'ALL ASSERTIONS PASSED';
end $$;

select 'ALL ASSERTIONS PASSED' as result;

rollback;
