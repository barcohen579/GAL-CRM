-- GAL CRM — "One current MANUAL follow-up per Lead" atomic creation.
--
-- Product principle (see the task's own spec): for an unresolved Lead,
-- Gal has exactly one current actionable follow-up. A MANUAL follow-up
-- she creates herself is the current source of truth (it carries the
-- latest human context/note/date); AUTOMATIC is the safety net that
-- resumes the moment no MANUAL one is active
-- (isAutomaticEscalationEligible/filterActionableFollowUps already
-- implement that "live check, no stored flag" resumption — untouched
-- here). What was still missing: creating a SECOND MANUAL follow-up for
-- a Lead that already had one PENDING left both rows PENDING at once,
-- so both rendered as separate actionable items and both could each
-- independently earn their own one-shot reminder email — this is what
-- surfaced as the ליד בדיקה Production case.
--
-- create_manual_follow_up_for_lead is the single authoritative,
-- transactional entry point for creating a Lead-linked MANUAL follow-up
-- going forward: in one transaction it (1) locks the Lead row (same
-- `for update` idiom already used by change_lead_stage/
-- convert_lead_to_won for their own per-lead concurrency safety — see
-- 20260902122314_..._lead_workflow_functions.sql), so two concurrent
-- calls for the SAME lead fully serialize rather than racing; (2)
-- CANCELS (never deletes — full history preserved) any still-PENDING
-- MANUAL follow-up already on that lead, recording auto_closed_reason;
-- then (3) inserts the new one as the single current PENDING MANUAL row.
-- Because every writer is serialized on the same lead row, no unique
-- constraint is even required for correctness here — but see the
-- follow-up migration (deliberately its own file, same "structural
-- change vs data cleanup get separate, individually reviewable
-- migrations" precedent as 20260904161000 vs 20260904162000) for the
-- partial unique index added as defense-in-depth, once Production's one
-- pre-existing Lead that already violates it (ליד בדיקה — from before
-- this invariant existed) has been cleaned up with explicit approval.
--
-- Deliberately scoped to Lead-linked follow-ups only (p_lead_id, not
-- customer_id): the "one current follow-up" principle only applies
-- where there is an AUTOMATIC fallback to coordinate with, and that is
-- Leads-only (create_automatic_followup_for_new_lead() only ever fires
-- on `leads`). A customer's own follow-ups are unaffected — see
-- app/(app)/follow-ups/actions.ts's createFollowUp, which still inserts
-- directly for a customer_id target and calls this function only for a
-- lead_id target.
--
-- SECURITY INVOKER, no search_path shortcuts, broad EXECUTE grant to
-- `authenticated` — same rationale as every other function in this
-- schema: RLS (is_crm_user()), not the grant, is what actually restricts
-- access, and this function adds no privilege beyond what the calling
-- CRM user already has directly on follow_up_tasks.

create or replace function public.create_manual_follow_up_for_lead(
  p_lead_id uuid,
  p_title text,
  p_notes text,
  p_due_at timestamptz
)
returns public.follow_up_tasks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_new public.follow_up_tasks;
begin
  -- Lock the Lead row first — this is the actual concurrency guarantee:
  -- a second concurrent call for the same lead blocks here until this
  -- transaction commits or rolls back, so it can never observe a state
  -- where "cancel old" has run but "insert new" has not (or vice
  -- versa), and it always sees this call's own newly-inserted row when
  -- it resumes.
  perform 1 from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'Lead not found or not accessible';
  end if;

  update public.follow_up_tasks
  set status = 'CANCELLED',
      auto_closed_reason = 'הוחלף במעקב ידני חדש שנוצרה לו',
      updated_at = now()
  where lead_id = p_lead_id
    and source = 'MANUAL'
    and status = 'PENDING';

  insert into public.follow_up_tasks (lead_id, title, notes, due_at, status, source)
  values (p_lead_id, p_title, p_notes, p_due_at, 'PENDING', 'MANUAL')
  returning * into v_new;

  return v_new;
end;
$$;

comment on function public.create_manual_follow_up_for_lead(uuid, text, text, timestamptz) is
  'The single authoritative way to create a Lead-linked MANUAL follow-up. '
  'Atomically (locks the Lead row first, so concurrent calls for the same '
  'lead serialize) cancels any still-PENDING MANUAL follow-up already on '
  'that lead — recording auto_closed_reason, never deleting — then inserts '
  'the new one as the Lead''s single current PENDING MANUAL follow-up. Does '
  'not touch the Lead''s AUTOMATIC follow-up (if any): it stays PENDING and '
  'simply remains suppressed from actionable views/escalation for as long '
  'as this new MANUAL one is itself PENDING, exactly as before.';

revoke all on function public.create_manual_follow_up_for_lead(uuid, text, text, timestamptz) from public;
grant execute on function public.create_manual_follow_up_for_lead(uuid, text, text, timestamptz) to authenticated;

comment on column public.follow_up_tasks.auto_closed_reason is
  'Set only when the system (not Gal directly clicking "ביטול מעקב") '
  'auto-cancels this follow-up: either its Lead reached WON or LOST (see '
  'change_lead_stage/convert_lead_to_won), or it was a MANUAL follow-up '
  'superseded by a newer one Gal just created for the same Lead (see '
  'create_manual_follow_up_for_lead above). Null for every manually- '
  'completed or manually-cancelled follow-up.';
