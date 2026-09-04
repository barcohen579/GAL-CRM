-- GAL CRM — Automatic Lead Follow-Up Escalation Loop
--
-- Implements (see the task's own full spec for the complete business
-- rules this migration encodes):
--
--   1. Day-0: every NEW lead (manual or Meta Lead Ads) automatically
--      gets ONE follow_up_tasks row, source = 'AUTOMATIC', due on the
--      next eligible Israel business day (Sun-Thu; Fri/Sat -> Sunday) —
--      via an AFTER INSERT trigger on leads, so no future lead-creation
--      code path can forget it (same "DB-enforced invariant over
--      trusting every call site" precedent as
--      create_follow_up_reminder_delivery() in the notifications
--      migration).
--   5. WON/LOST always stops the loop: convert_lead_to_won() and
--      change_lead_stage() (the ONLY two authoritative paths that can
--      ever set leads.stage — verified by inspection, see the task's
--      own report) are extended, in the SAME transaction as the stage
--      change, to auto-close every still-PENDING follow_up_tasks row
--      for that lead (CANCELLED, never deleted — full history
--      preserved; auto_closed_reason records why). This is what keeps
--      "lead -> WON/LOST" and "pending follow-ups -> no longer
--      actionable" from ever getting out of sync: every consumer
--      (/follow-ups, the dashboard counts, the digest, both cron
--      reminder paths) already filters on follow_up_tasks.status =
--      'PENDING' with no lead.stage join at all, so fixing status here
--      fixes every consumer with zero query changes anywhere else.
--   6. A competing MANUAL follow-up suspends the automatic escalation —
--      deliberately NOT a stored "suspended" flag; see
--      lib/notifications/reminder-logic.ts's isAutomaticEscalationEligible
--      for why a live per-tick check is sufficient and self-resuming.
--   10. lead_auto_escalation_deliveries is the append-only, per-Israel-
--      calendar-day delivery ledger for the REPEATING daily escalation
--      email — distinct from follow_up_reminder_deliveries (which is
--      one-shot, one row per task, EVER). UNIQUE (follow_up_task_id,
--      escalation_date) is the actual "never twice for the same lead +
--      eligible day" guarantee; the application-level
--      isAutomaticEscalationEligible check is a second, defense-in-
--      depth guard on top of it, not the primary one.
--   11. All day/date arithmetic here mirrors
--      lib/crm/timezone.ts's isFollowUpBusinessDay/nextEligibleFollowUpDay
--      (Sun-Thu eligible, Fri/Sat skipped) but computed in SQL via
--      Postgres's own IANA tz data (`at time zone 'Asia/Jerusalem'`),
--      so the trigger needs no round-trip to application code and stays
--      DST-safe for the same reason the TS helpers are.
--
-- Deliberately NOT included here: any backfill/reclassification of
-- EXISTING follow_up_tasks/leads rows. That is a separate, explicitly
-- approved, one-time Production data migration
-- (20260904162000_..._followup_escalation_production_backfill.sql) —
-- kept apart from this structural migration so the schema/behavior
-- change and the one-off data change each have their own, individually
-- reviewable migration history.

-- ============================================================
-- follow_up_tasks.auto_closed_reason — set ONLY by the automatic
-- WON/LOST auto-cancel below, never by any user-facing action (Gal's
-- own "ביטול מעקב" cancel keeps this null). Distinct from
-- completed_note (Gal's own words, COMPLETED only) and from the task's
-- own `notes` (its original description) — this column exists purely
-- to answer "why did this become CANCELLED without anyone clicking
-- cancel" when looking at history later.
-- ============================================================

alter table public.follow_up_tasks
  add column auto_closed_reason text;

comment on column public.follow_up_tasks.auto_closed_reason is
  'Set only when the system (not Gal) auto-cancels this follow-up '
  'because its lead reached WON or LOST (see change_lead_stage/'
  'convert_lead_to_won below). Null for every manually-completed or '
  'manually-cancelled follow-up.';

-- At most one AUTOMATIC follow-up per lead, ever — defense-in-depth on
-- top of the trigger only ever firing once (on the lead's own INSERT):
-- makes "a lead can have at most one Day-0 automatic follow-up" a real,
-- DB-enforced invariant, not just an emergent property of when the
-- trigger happens to fire.
create unique index follow_up_tasks_one_automatic_per_lead
  on public.follow_up_tasks (lead_id)
  where source = 'AUTOMATIC';

-- ============================================================
-- next_eligible_follow_up_date — SQL mirror of
-- lib/crm/timezone.ts's nextEligibleFollowUpDay: the next Israel
-- calendar date strictly after p_from's own Israel calendar date,
-- skipping Friday/Saturday. isodow: Mon=1 .. Sun=7, so Friday=5,
-- Saturday=6 — the same two values the TS helper treats as ineligible.
-- ============================================================

create or replace function public.next_eligible_follow_up_date(p_from timestamptz)
returns date
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_date date;
begin
  v_date := ((p_from at time zone 'Asia/Jerusalem')::date) + 1;
  while extract(isodow from v_date) in (5, 6) loop
    v_date := v_date + 1;
  end loop;
  return v_date;
end;
$$;

comment on function public.next_eligible_follow_up_date(timestamptz) is
  'The next Israel calendar date strictly after p_from, skipping '
  'Friday/Saturday. SQL mirror of lib/crm/timezone.ts''s '
  'nextEligibleFollowUpDay — Thu -> Sun, Fri -> Sun, Sat -> Sun, every '
  'other day -> the next calendar day.';

revoke all on function public.next_eligible_follow_up_date(timestamptz) from public;
grant execute on function public.next_eligible_follow_up_date(timestamptz) to authenticated, service_role;

-- ============================================================
-- create_automatic_followup_for_new_lead — AFTER INSERT trigger on
-- leads: creates the Day-0 AUTOMATIC follow_up_tasks row for every new
-- lead, regardless of how it was created (the createLead Server Action
-- runs as the authenticated user; Meta Lead Ads ingestion runs as
-- service_role — both already have INSERT on leads, but a trigger,
-- not app-code discipline, is what guarantees neither path — nor any
-- future one — can forget this, matching
-- create_follow_up_reminder_delivery()'s own precedent and reasoning).
--
-- due_at is set to 09:00 Israel time on the next eligible day — a
-- fixed, documented default business-hours time (not user-chosen,
-- since nothing prompts anyone for one at lead-creation time); '
-- Gal can always retime it like any other follow-up.
--
-- SECURITY DEFINER: needed so this fires identically regardless of the
-- inserting role's own grants on follow_up_tasks (authenticated has
-- full CRUD there already; service_role currently does not, and
-- SECURITY DEFINER avoids having to keep two different callers' grants
-- in sync for this one insert — same reasoning as
-- create_follow_up_reminder_delivery()).
-- ============================================================

create or replace function public.create_automatic_followup_for_new_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due_date date;
begin
  v_due_date := public.next_eligible_follow_up_date(new.created_at);

  insert into public.follow_up_tasks (lead_id, title, due_at, status, source)
  values (
    new.id,
    'מעקב אוטומטי לליד חדש',
    (v_due_date + time '09:00') at time zone 'Asia/Jerusalem',
    'PENDING',
    'AUTOMATIC'
  );

  return new;
end;
$$;

comment on function public.create_automatic_followup_for_new_lead() is
  'AFTER INSERT trigger on leads: creates the Day-0 AUTOMATIC '
  'follow_up_tasks row every new lead needs, regardless of source '
  '(manual or Meta Lead Ads), due 09:00 Israel time on the next '
  'eligible business day. SECURITY DEFINER — see this function''s own '
  'comment above.';

revoke all on function public.create_automatic_followup_for_new_lead() from public;
revoke all on function public.create_automatic_followup_for_new_lead() from authenticated;

create trigger create_automatic_followup
  after insert on public.leads
  for each row execute function public.create_automatic_followup_for_new_lead();

-- ============================================================
-- WON/LOST auto-close: replace change_lead_stage() and
-- convert_lead_to_won() to, in the SAME transaction as the stage
-- change, cancel every still-PENDING follow_up_tasks row belonging to
-- that lead (any source — AUTOMATIC or MANUAL alike). CREATE OR REPLACE
-- preserves each function's existing grants (both already
-- `grant execute ... to authenticated`), so no re-grant is needed.
-- completed_at is deliberately left null (the existing check constraint
-- follow_up_tasks_completed_at_consistency already requires that for
-- any non-COMPLETED status) — CANCELLED, not COMPLETED, is used because
-- Gal did not actually carry out these follow-ups; the need for them
-- simply evaporated when the lead's outcome changed. auto_closed_reason
-- records why, for anyone reading the follow-up's history later; the
-- correlated lead_stage_events row (same transaction, same `now()`)
-- is the natural cross-reference for who/when.
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

  if p_new_stage = 'LOST' then
    update public.follow_up_tasks
    set status = 'CANCELLED',
        auto_closed_reason = 'הליד סומן כאבוד (LOST) — המעקב בוטל אוטומטית',
        updated_at = now()
    where lead_id = p_lead_id
      and status = 'PENDING';
  end if;
end;
$$;

comment on function public.change_lead_stage(uuid, public.lead_stage, public.lead_lost_reason) is
  'Atomically updates a lead''s stage, stage_changed_at and lost_reason, '
  'records the transition in lead_stage_events, and — when the new '
  'stage is LOST — auto-cancels every still-PENDING follow_up_tasks row '
  'for that lead (any source), all in one transaction. No-op when the '
  'requested stage equals the current one. Rejects WON — use '
  'convert_lead_to_won for that transition.';

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

  update public.follow_up_tasks
  set status = 'CANCELLED',
      auto_closed_reason = 'הליד הפך ללקוחה (WON) — המעקב בוטל אוטומטית',
      updated_at = now()
  where lead_id = p_lead_id
    and status = 'PENDING';

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
  'Atomically converts a lead to WON: updates the lead, records the '
  'stage event, auto-cancels every still-PENDING follow_up_tasks row '
  'for that lead (any source), finds-or-creates the customer, and '
  'creates the purchase — all in one transaction.';

-- ============================================================
-- lead_auto_escalation_deliveries — append-only, per-Israel-calendar-
-- day delivery ledger for the REPEATING automatic escalation email
-- (see this migration's own header). Never updated across days — a
-- fresh row per (follow_up_task_id, escalation_date); the unique
-- constraint is the actual "never twice" guarantee.
-- ============================================================

create type public.escalation_delivery_status as enum (
  'SENDING',
  'SENT',
  'FAILED'
);

create table public.lead_auto_escalation_deliveries (
  id uuid primary key default gen_random_uuid(),
  follow_up_task_id uuid not null references public.follow_up_tasks(id) on delete cascade,
  -- The Israel CALENDAR date this occurrence is FOR (computed via
  -- lib/crm/timezone.ts's zonedParts in the cron route) — part of the
  -- idempotency key, never the server's own local date.
  escalation_date date not null,
  status public.escalation_delivery_status not null default 'SENDING',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempted_at timestamptz not null default now(),
  last_error text,
  provider_message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_auto_escalation_deliveries_sent_at_requires_sent
    check ((status = 'SENT') = (sent_at is not null)),
  constraint lead_auto_escalation_deliveries_unique_occurrence
    unique (follow_up_task_id, escalation_date)
);

comment on table public.lead_auto_escalation_deliveries is
  'Delivery-tracking ledger for the REPEATING automatic new-lead '
  'escalation email — one row per (follow_up_task_id, escalation_date), '
  'never reused across days (unlike follow_up_reminder_deliveries, '
  'which is one-shot per task). The unique constraint on '
  '(follow_up_task_id, escalation_date) is the DB-level guarantee that '
  'one automatic reminder can never be sent twice for the same lead + '
  'eligible Israel day. Server/cron-only — no RLS policy grants '
  '`authenticated` any access.';

create index lead_auto_escalation_deliveries_task_idx
  on public.lead_auto_escalation_deliveries (follow_up_task_id);
create index lead_auto_escalation_deliveries_status_idx
  on public.lead_auto_escalation_deliveries (status);

create trigger set_updated_at
  before update on public.lead_auto_escalation_deliveries
  for each row execute function public.set_updated_at();

alter table public.lead_auto_escalation_deliveries enable row level security;
-- Deliberately zero policies — pure server-automation state, touched
-- only by the cron's service_role client, same pattern as
-- follow_up_reminder_deliveries/daily_digest_deliveries.

grant select, insert, update on public.lead_auto_escalation_deliveries to service_role;
