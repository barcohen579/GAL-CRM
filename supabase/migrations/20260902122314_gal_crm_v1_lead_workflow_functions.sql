-- GAL CRM V1 — atomic lead-stage-change and WON-conversion functions
--
-- Why these need to be database functions rather than sequential client
-- requests:
--
-- change_lead_stage touches two tables (leads + lead_stage_events) that
-- must succeed or fail together. convert_lead_to_won touches four
-- (leads, lead_stage_events, customers, purchases) — if a customer gets
-- created but the purchase insert then fails, that's an orphaned
-- customer with no purchase and a lead stuck at WON with no revenue
-- record. The Supabase JS client has no multi-table transaction
-- primitive, so doing this as several sequential requests from a Server
-- Action risks exactly that kind of partial write if a later step
-- fails. A single SQL function body IS one Postgres transaction: every
-- statement inside commits together or the whole call rolls back.
--
-- Both functions are SECURITY INVOKER (the default — stated explicitly
-- for clarity, not relying on the default) and run entirely as the
-- calling authenticated user. They add no new privilege: every
-- statement inside is still subject to the exact same RLS policies and
-- table grants as if the caller had issued it directly via the normal
-- client. A caller who is not an active CRM user (fails is_crm_user())
-- gets the same "permission denied" / zero-rows outcome as any other
-- route into these tables — these functions do not bypass that. EXECUTE
-- is granted broadly to `authenticated` deliberately, because RLS — not
-- this grant — is what actually restricts access, exactly matching
-- every table in this schema.

-- ============================================================
-- change_lead_stage
--
-- Moves a lead to any stage EXCEPT WON (rejected — WON must go through
-- convert_lead_to_won, since it has side effects beyond a stage flip).
-- No-ops cleanly (no stage_changed_at bump, no lead_stage_events row)
-- when the requested stage equals the current one, so re-selecting the
-- same stage in the UI never creates a duplicate history entry.
-- lost_reason is only ever populated while the lead is actually LOST —
-- moving to any other stage clears it, moving into LOST sets it from
-- the caller-supplied value (which may itself be null: an optional
-- reason).
-- ============================================================

create or replace function public.change_lead_stage(
  p_lead_id uuid,
  p_new_stage public.lead_stage,
  p_lost_reason public.lead_lost_reason default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_prev_stage public.lead_stage;
  v_changed_by uuid;
begin
  if p_new_stage = 'WON' then
    raise exception 'change_lead_stage cannot be used for WON — use convert_lead_to_won instead';
  end if;

  select stage into v_prev_stage
  from public.leads
  where id = p_lead_id
  for update;

  if not found then
    raise exception 'Lead not found or not accessible';
  end if;

  if v_prev_stage = p_new_stage then
    return;
  end if;

  select id into v_changed_by
  from public.app_users
  where auth_user_id = auth.uid();

  update public.leads
  set stage = p_new_stage,
      stage_changed_at = now(),
      lost_reason = case when p_new_stage = 'LOST' then p_lost_reason else null end,
      updated_at = now()
  where id = p_lead_id;

  insert into public.lead_stage_events (lead_id, from_stage, to_stage, changed_at, changed_by)
  values (p_lead_id, v_prev_stage, p_new_stage, now(), v_changed_by);
end;
$$;

comment on function public.change_lead_stage(uuid, public.lead_stage, public.lead_lost_reason) is
  'Atomically updates a lead''s stage, stage_changed_at and lost_reason, and '
  'records the transition in lead_stage_events in one transaction. No-op when '
  'the requested stage equals the current one. Rejects WON — use '
  'convert_lead_to_won for that transition.';

revoke all on function public.change_lead_stage(uuid, public.lead_stage, public.lead_lost_reason) from public;
grant execute on function public.change_lead_stage(uuid, public.lead_stage, public.lead_lost_reason) to authenticated;

-- ============================================================
-- convert_lead_to_won
--
-- The WON conversion flow: update the lead, record the stage event,
-- find-or-create the customer for that lead's contact (never creating a
-- duplicate customer for a contact who already has one — this is the
-- actual mechanism behind "a person is never recreated as a customer"),
-- then create the purchase linking that customer back to the
-- originating lead. Returns the resulting customer_id and purchase_id
-- so the caller can navigate straight to them. Deliberately does NOT
-- create a payment — recording money collected is a separate, later
-- action (per spec).
-- ============================================================

create or replace function public.convert_lead_to_won(
  p_lead_id uuid,
  p_service_type public.service_type,
  p_custom_service_name text,
  p_agreed_price_amount integer,
  p_recurrence public.purchase_recurrence,
  p_start_date date,
  p_notes text default null
)
returns table (customer_id uuid, purchase_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_contact_id uuid;
  v_prev_stage public.lead_stage;
  v_changed_by uuid;
  v_customer_id uuid;
  v_purchase_id uuid;
begin
  select contact_id, stage into v_contact_id, v_prev_stage
  from public.leads
  where id = p_lead_id
  for update;

  if not found then
    raise exception 'Lead not found or not accessible';
  end if;

  if v_prev_stage = 'WON' then
    raise exception 'This lead is already WON';
  end if;

  select id into v_changed_by
  from public.app_users
  where auth_user_id = auth.uid();

  update public.leads
  set stage = 'WON',
      stage_changed_at = now(),
      lost_reason = null,
      updated_at = now()
  where id = p_lead_id;

  insert into public.lead_stage_events (lead_id, from_stage, to_stage, changed_at, changed_by)
  values (p_lead_id, v_prev_stage, 'WON', now(), v_changed_by);

  select id into v_customer_id
  from public.customers
  where contact_id = v_contact_id;

  if v_customer_id is null then
    insert into public.customers (contact_id, customer_since, status)
    values (v_contact_id, p_start_date, 'ACTIVE')
    returning id into v_customer_id;
  end if;

  insert into public.purchases (
    customer_id, lead_id, service_type, custom_service_name,
    agreed_price_amount, agreed_price_currency, recurrence,
    start_date, status, notes
  )
  values (
    v_customer_id, p_lead_id, p_service_type, p_custom_service_name,
    p_agreed_price_amount, 'ILS', p_recurrence,
    p_start_date, 'ACTIVE', p_notes
  )
  returning id into v_purchase_id;

  return query select v_customer_id, v_purchase_id;
end;
$$;

comment on function public.convert_lead_to_won(uuid, public.service_type, text, integer, public.purchase_recurrence, date, text) is
  'Atomically converts a lead to WON: updates the lead, records the stage '
  'event, finds-or-creates the customer for that contact, and creates the '
  'purchase -- all in one transaction so a failure partway through never '
  'leaves an orphaned customer or a WON lead with no purchase. Does not '
  'record a payment; that remains a separate, later action.';

revoke all on function public.convert_lead_to_won(uuid, public.service_type, text, integer, public.purchase_recurrence, date, text) from public;
grant execute on function public.convert_lead_to_won(uuid, public.service_type, text, integer, public.purchase_recurrence, date, text) to authenticated;
