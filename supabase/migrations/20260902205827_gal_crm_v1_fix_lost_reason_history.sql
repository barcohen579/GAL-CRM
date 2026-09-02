-- Fix: lead_stage_events did not retain the LOST reason on the event row
-- itself. lib/crm/timeline.ts was deriving the "סיבה: ..." description for
-- a historical LOST transition from leads.lost_reason (the lead's CURRENT
-- value), not from what was true at the time of that transition. Reopening
-- a LOST lead clears leads.lost_reason (by design, in this same function)
-- — which silently erased the reason shown against the earlier LOST entry
-- in the activity timeline, even though that transition genuinely happened
-- with that reason. Found during manual validation of the LOST → reopen
-- flow (see recovery/validation session).
--
-- Fix: store the reason on the lead_stage_events.note column (which
-- already exists for exactly this purpose) at the moment of the LOST
-- transition, so it is immutable history from then on. The application
-- layer (lib/crm/timeline.ts) is updated in the same change to read the
-- reason from the event's own note instead of the lead's current state.
--
-- This replaces the change_lead_stage function body only; signature,
-- grants and WON-rejection behavior are unchanged. CREATE OR REPLACE
-- preserves existing grants in Postgres, so no re-grant is needed.

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

  insert into public.lead_stage_events (lead_id, from_stage, to_stage, changed_at, changed_by, note)
  values (
    p_lead_id, v_prev_stage, p_new_stage, now(), v_changed_by,
    case
      when p_new_stage = 'LOST' and p_lost_reason is not null then p_lost_reason::text
      else null
    end
  );
end;
$$;

comment on function public.change_lead_stage(uuid, public.lead_stage, public.lead_lost_reason) is
  'Atomically updates a lead''s stage, stage_changed_at and lost_reason, and '
  'records the transition in lead_stage_events in one transaction — storing '
  'the lost reason on the event''s own note column when moving to LOST, so '
  'it remains accurate history even after the lead is later reopened. '
  'No-op when the requested stage equals the current one. Rejects WON — use '
  'convert_lead_to_won for that transition.';
