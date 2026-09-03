-- GAL CRM V1 — teach delete_lead_safely about lead_interested_services
--
-- public.lead_interested_services (this session's earlier migration,
-- 20260903113057_...sql) is a new lead-specific operational table —
-- exactly the category delete_lead_safely's own documented design
-- explicitly commits to cleaning up EXPLICITLY, never by relying on
-- its ON DELETE CASCADE implicitly (see that function's original
-- migration, 20260903101406_...sql, for the full rationale). This
-- migration keeps that promise for the newly-added table.
--
-- Not a behavior change in practice: lead_interested_services.lead_id
-- is ON DELETE CASCADE, so Postgres already removed these rows
-- automatically when a lead was deleted, with or without this
-- explicit statement. This is purely restoring the function's own
-- stated self-documentation contract, at zero functional risk.

create or replace function public.delete_lead_safely(p_lead_id uuid)
returns table (contact_deleted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact_id uuid;
  v_customer_exists boolean;
  v_purchase_exists boolean;
  v_other_leads_count integer;
  v_contact_deleted boolean := false;
begin
  if not public.is_crm_user() then
    raise exception 'Not authorized to delete leads';
  end if;

  select contact_id into v_contact_id
  from public.leads
  where id = p_lead_id
  for update;

  if not found then
    raise exception 'Lead not found or not accessible';
  end if;

  select exists(
    select 1 from public.customers where contact_id = v_contact_id
  ) into v_customer_exists;

  select exists(
    select 1 from public.purchases where lead_id = p_lead_id
  ) into v_purchase_exists;

  if v_customer_exists or v_purchase_exists then
    raise exception 'Cannot delete this lead: the associated contact has customer/purchase history that must be preserved.'
      using errcode = 'GALB1';
  end if;

  delete from public.lead_interested_services where lead_id = p_lead_id;
  delete from public.lead_stage_events where lead_id = p_lead_id;
  delete from public.touchpoints where lead_id = p_lead_id;
  delete from public.follow_up_tasks where lead_id = p_lead_id;
  delete from public.leads where id = p_lead_id;

  select count(*) into v_other_leads_count
  from public.leads
  where contact_id = v_contact_id;

  if v_other_leads_count = 0 then
    delete from public.contacts
    where id = v_contact_id
      and not exists (select 1 from public.leads where contact_id = v_contact_id)
      and not exists (select 1 from public.customers where contact_id = v_contact_id);
    if found then
      v_contact_deleted := true;
    end if;
  end if;

  return query select v_contact_deleted;
end;
$$;

revoke all on function public.delete_lead_safely(uuid) from public;
grant execute on function public.delete_lead_safely(uuid) to authenticated;
