-- GAL CRM V2 — Lead Workflow V2: simplified notifications, conversation
-- tracking, structured LOST reasons, atomic manual lead creation.
--
-- Owner-approved product rules this migration encodes (see the V2 task
-- spec; summarized here so the schema is self-explanatory):
--
--   * Exactly two routine reminder emails exist, both ONE-SHOT per
--     follow_up_tasks row, both delivered through the existing
--     follow_up_reminder_deliveries ledger:
--       - AUTOMATIC ("new lead") task: one reminder at its due_at, which
--         create_automatic_followup_for_new_lead() already sets to 10:00
--         Asia/Jerusalem on the next eligible business day (Sun-Thu).
--       - MANUAL task (lead or customer): one reminder at 10:00
--         Asia/Jerusalem on the next eligible business day STRICTLY
--         AFTER the task's own Israel due date — i.e. only once the task
--         is genuinely overdue ("due Tuesday, still pending Wednesday
--         10:00 -> one email Wednesday").
--     The old repeating daily escalation, the daily digest and the
--     immediate Meta new-lead email are retired in application code;
--     their ledgers (lead_auto_escalation_deliveries,
--     daily_digest_deliveries, meta_lead_ingestions.notification_*) are
--     KEPT as read-only history — nothing here drops or rewrites them.
--   * follow_up_reminder_deliveries.remind_at is the single stored
--     answer to "when does this task's one reminder become eligible",
--     computed by follow_up_reminder_at() at task creation (and kept in
--     sync if due_at ever changes while unsent).
--   * claim_due_follow_up_reminders() is the ONLY way a reminder is
--     claimed: filtered to still-PENDING tasks with remind_at <= now,
--     ORDERED by remind_at, bounded, FOR UPDATE SKIP LOCKED (fixes the
--     audit's LIMIT-200-unordered starvation and makes concurrent cron
--     runs claim disjoint rows), with bounded retry and stale-SENDING
--     recovery (fixes rows stuck in SENDING forever). The application
--     sends with a Resend Idempotency-Key derived from the delivery id,
--     so a reclaimed stale SENDING row cannot produce a second email
--     within Resend's 24h idempotency window even if the first attempt
--     was accepted just before the process died.
--   * A task that is closed (completed/cancelled/superseded) before its
--     reminder goes out has its delivery row marked SKIPPED by trigger —
--     explicit terminal state instead of PENDING-forever.
--   * Creating a MANUAL follow-up for a lead permanently closes its
--     still-PENDING AUTOMATIC task. Moving a lead out of NEW (it is being
--     handled) does the same. WON/LOST still cancels everything.
--   * A WON lead's stage is final (no silent reopen that could later
--     re-WON into a duplicate purchase); convert_lead_to_won also
--     refuses a lead that already has a purchase.
--   * LOST requires a reason (OTHER requires a written explanation);
--     reason + explanation are stored on leads AND on the
--     lead_stage_events row, restoring the history write that
--     20260904161000 accidentally dropped (audit finding).
--   * lead_conversation_updates: append-only, timestamped conversation
--     outcome + note history per lead, written together with the
--     optional stage change and optional MANUAL follow-up by
--     record_lead_conversation() in ONE transaction.
--   * create_lead_manually(): manual lead creation in one transaction
--     (contact, lead, services, touchpoint, referral), with a
--     duplicate-phone/email WARNING (never an automatic merge).

-- ============================================================
-- 1. Reminder timing
-- ============================================================

create or replace function public.follow_up_reminder_at(
  p_source public.task_source,
  p_due_at timestamptz
)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_source = 'AUTOMATIC' then
    -- Already 10:00 Israel time on the next eligible business day (set
    -- by create_automatic_followup_for_new_lead()).
    return p_due_at;
  end if;
  return (public.next_eligible_follow_up_date(p_due_at) + time '10:00') at time zone 'Asia/Jerusalem';
end;
$$;

comment on function public.follow_up_reminder_at(public.task_source, timestamptz) is
  'When a follow-up''s single reminder email becomes eligible. AUTOMATIC: '
  'its own due_at (10:00 Israel, next Sun-Thu after lead creation). '
  'MANUAL/other: 10:00 Israel on the next Sun-Thu strictly after the '
  'task''s Israel due date (i.e. once it is overdue).';

revoke all on function public.follow_up_reminder_at(public.task_source, timestamptz) from public;
grant execute on function public.follow_up_reminder_at(public.task_source, timestamptz) to authenticated, service_role;

alter table public.follow_up_reminder_deliveries
  add column remind_at timestamptz,
  add column skipped_reason text;

update public.follow_up_reminder_deliveries d
set remind_at = public.follow_up_reminder_at(t.source, t.due_at)
from public.follow_up_tasks t
where t.id = d.follow_up_task_id
  and d.remind_at is null;

alter table public.follow_up_reminder_deliveries
  alter column remind_at set not null;

comment on column public.follow_up_reminder_deliveries.remind_at is
  'When this task''s single reminder becomes eligible — see '
  'follow_up_reminder_at(). Claimed only by claim_due_follow_up_reminders().';
comment on column public.follow_up_reminder_deliveries.skipped_reason is
  'Why a SKIPPED delivery will never be sent (task closed before the '
  'reminder, or a pre-V2 legacy row retired by the V2 transition).';

create index follow_up_reminder_deliveries_due_idx
  on public.follow_up_reminder_deliveries (remind_at)
  where status in ('PENDING', 'FAILED', 'SENDING');

create or replace function public.create_follow_up_reminder_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.follow_up_reminder_deliveries (follow_up_task_id, status, remind_at)
  values (new.id, 'PENDING', public.follow_up_reminder_at(new.source, new.due_at));
  return new;
end;
$$;

-- Keeps the delivery row consistent with its task: a task that closes
-- before its reminder is sent gets an explicit SKIPPED delivery (never
-- claimable again); a still-unsent task whose due_at changes gets its
-- remind_at recomputed. A SENDING row (in flight) is left alone — the
-- claim/record path re-checks the task status itself.
create or replace function public.sync_follow_up_reminder_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'PENDING' and old.status = 'PENDING' then
    update public.follow_up_reminder_deliveries
    set status = 'SKIPPED',
        skipped_reason = case new.status
          when 'COMPLETED' then 'task completed before reminder'
          else 'task cancelled before reminder'
        end
    where follow_up_task_id = new.id
      and status in ('PENDING', 'FAILED');
  elsif new.status = 'PENDING' and new.due_at is distinct from old.due_at then
    update public.follow_up_reminder_deliveries
    set remind_at = public.follow_up_reminder_at(new.source, new.due_at)
    where follow_up_task_id = new.id
      and status in ('PENDING', 'FAILED');
  end if;
  return new;
end;
$$;

revoke all on function public.sync_follow_up_reminder_delivery() from public;
revoke all on function public.sync_follow_up_reminder_delivery() from authenticated;

create trigger sync_reminder_delivery
  after update of status, due_at on public.follow_up_tasks
  for each row execute function public.sync_follow_up_reminder_delivery();

-- ============================================================
-- 2. Claiming due reminders (the only claim path)
-- ============================================================

create or replace function public.claim_due_follow_up_reminders(
  p_limit integer default 20,
  p_max_attempts integer default 5,
  p_retry_backoff_minutes integer default 30,
  p_stale_sending_minutes integer default 15,
  -- Injectable clock for deterministic SQL regression tests only; the
  -- cron always calls this with the default.
  p_now timestamptz default now()
)
returns table (delivery_id uuid, follow_up_task_id uuid, attempt_count integer)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now timestamptz := coalesce(p_now, now());
begin
  -- Quiet weekend (Israel calendar day): nothing is ever claimed.
  if extract(isodow from (v_now at time zone 'Asia/Jerusalem')) in (5, 6) then
    return;
  end if;

  -- A SENDING row whose worker died after its LAST allowed attempt can
  -- never be reclaimed below — finalize it as FAILED so it is visibly
  -- exhausted instead of silently stuck.
  update public.follow_up_reminder_deliveries d
  set status = 'FAILED',
      last_error = coalesce(d.last_error, 'interrupted while sending; attempts exhausted')
  where d.status = 'SENDING'
    and d.attempt_count >= p_max_attempts
    and d.last_attempted_at <= v_now - make_interval(mins => p_stale_sending_minutes);

  return query
  with candidates as (
    select d.id
    from public.follow_up_reminder_deliveries d
    join public.follow_up_tasks t on t.id = d.follow_up_task_id
    left join public.leads l on l.id = t.lead_id
    where t.status = 'PENDING'
      and (t.lead_id is null or l.stage not in ('WON', 'LOST'))
      and d.remind_at <= v_now
      and d.attempt_count < p_max_attempts
      and (
        d.status = 'PENDING'
        or (d.status = 'FAILED'
            and (d.last_attempted_at is null
                 or d.last_attempted_at <= v_now - make_interval(mins => p_retry_backoff_minutes)))
        or (d.status = 'SENDING'
            and d.last_attempted_at <= v_now - make_interval(mins => p_stale_sending_minutes))
      )
    order by d.remind_at, d.id
    limit p_limit
    for update of d skip locked
  )
  update public.follow_up_reminder_deliveries d
  set status = 'SENDING',
      attempt_count = d.attempt_count + 1,
      last_attempted_at = v_now
  from candidates c
  where d.id = c.id
  returning d.id, d.follow_up_task_id, d.attempt_count;
end;
$$;

comment on function public.claim_due_follow_up_reminders(integer, integer, integer, integer, timestamptz) is
  'Atomically claims up to p_limit due reminder deliveries (oldest '
  'remind_at first) for still-PENDING tasks of unresolved leads/customers, '
  'flipping them to SENDING and incrementing attempt_count. Retries FAILED '
  'rows after p_retry_backoff_minutes and reclaims SENDING rows older than '
  'p_stale_sending_minutes, both bounded by p_max_attempts. FOR UPDATE SKIP '
  'LOCKED: concurrent callers always claim disjoint rows. Never claims on an '
  'Israel Friday/Saturday. service_role only.';

revoke all on function public.claim_due_follow_up_reminders(integer, integer, integer, integer, timestamptz) from public;
revoke all on function public.claim_due_follow_up_reminders(integer, integer, integer, integer, timestamptz) from authenticated;
grant execute on function public.claim_due_follow_up_reminders(integer, integer, integer, integer, timestamptz) to service_role;

-- ============================================================
-- 3. AUTOMATIC task: human-readable title for new rows
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
    'ליד חדש — ליצור קשר ראשון',
    (v_due_date + time '10:00') at time zone 'Asia/Jerusalem',
    'PENDING',
    'AUTOMATIC'
  );

  return new;
end;
$$;

-- ============================================================
-- 4. MANUAL follow-up creation also closes the AUTOMATIC task
-- ============================================================

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

  -- V2: a manual follow-up means Gal is handling this lead — the new-lead
  -- AUTOMATIC task (and its one reminder, if not yet sent) is closed for
  -- good. It is never recreated (one AUTOMATIC per lead, ever).
  update public.follow_up_tasks
  set status = 'CANCELLED',
      auto_closed_reason = 'נסגר אוטומטית — נוצר מעקב ידני לליד',
      updated_at = now()
  where lead_id = p_lead_id
    and source = 'AUTOMATIC'
    and status = 'PENDING';

  insert into public.follow_up_tasks (lead_id, title, notes, due_at, status, source)
  values (p_lead_id, p_title, p_notes, p_due_at, 'PENDING', 'MANUAL')
  returning * into v_new;

  return v_new;
end;
$$;

-- ============================================================
-- 5. Structured LOST reason on leads and stage history
-- ============================================================

alter table public.leads
  add column lost_reason_note text;

alter table public.leads
  add constraint leads_lost_reason_note_requires_lost_stage
    check (lost_reason_note is null or stage = 'LOST');

alter table public.lead_stage_events
  add column lost_reason public.lead_lost_reason,
  add column lost_reason_note text;

comment on column public.lead_stage_events.lost_reason is
  'Structured LOST reason captured at the moment of this transition '
  '(immutable history; survives later reopening).';
comment on column public.lead_stage_events.lost_reason_note is
  'Optional free-text explanation captured with the LOST reason '
  '(required when the reason is OTHER).';

-- Historical events: the pre-regression fix stored the reason code in
-- `note` — copy it into the structured column (exact, not inferred).
update public.lead_stage_events
set lost_reason = note::public.lead_lost_reason
where to_stage = 'LOST'
  and lost_reason is null
  and note in (
    'PRICE', 'TIMING', 'NO_RESPONSE', 'CHOSE_COMPETITOR', 'NOT_INTERESTED', 'OTHER'
  );

-- Events written during the regression (no note): recover the reason
-- ONLY where it is exact — the lead is still LOST and this event is its
-- most recent stage event, so leads.lost_reason was set by exactly this
-- transition. Anything else is left null (never invented).
update public.lead_stage_events e
set lost_reason = l.lost_reason
from public.leads l
where l.id = e.lead_id
  and e.to_stage = 'LOST'
  and e.lost_reason is null
  and l.stage = 'LOST'
  and l.lost_reason is not null
  and e.id = (
    select e2.id from public.lead_stage_events e2
    where e2.lead_id = e.lead_id
    order by e2.changed_at desc, e2.id desc
    limit 1
  );

drop function public.change_lead_stage(uuid, public.lead_stage, public.lead_lost_reason);

create function public.change_lead_stage(
  p_lead_id uuid,
  p_new_stage public.lead_stage,
  p_lost_reason public.lead_lost_reason default null,
  p_lost_reason_note text default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_prev_stage public.lead_stage;
  v_changed_by uuid;
  v_note text := nullif(btrim(coalesce(p_lost_reason_note, '')), '');
begin
  if p_new_stage = 'WON' then
    raise exception 'change_lead_stage cannot be used for WON — use convert_lead_to_won instead';
  end if;

  if p_new_stage = 'LOST' and p_lost_reason is null then
    raise exception 'A LOST lead requires a reason' using errcode = 'GALL1';
  end if;
  if p_new_stage = 'LOST' and p_lost_reason = 'OTHER' and v_note is null then
    raise exception 'The OTHER lost reason requires a written explanation' using errcode = 'GALL2';
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

  -- V2 safest-minimal reopen guard: a WON lead already has a customer and
  -- purchase; moving it back into the pipeline (and potentially re-WON,
  -- creating a duplicate purchase) is not allowed.
  if v_prev_stage = 'WON' then
    raise exception 'A WON lead cannot be moved to another stage' using errcode = 'GALW1';
  end if;

  select id into v_changed_by
  from public.app_users
  where auth_user_id = auth.uid();

  update public.leads
  set stage = p_new_stage,
      stage_changed_at = now(),
      lost_reason = case when p_new_stage = 'LOST' then p_lost_reason else null end,
      lost_reason_note = case when p_new_stage = 'LOST' then v_note else null end,
      updated_at = now()
  where id = p_lead_id;

  insert into public.lead_stage_events (
    lead_id, from_stage, to_stage, changed_at, changed_by, note, lost_reason, lost_reason_note
  )
  values (
    p_lead_id, v_prev_stage, p_new_stage, now(), v_changed_by,
    case when p_new_stage = 'LOST' then p_lost_reason::text else null end,
    case when p_new_stage = 'LOST' then p_lost_reason else null end,
    case when p_new_stage = 'LOST' then v_note else null end
  );

  if p_new_stage = 'LOST' then
    update public.follow_up_tasks
    set status = 'CANCELLED',
        auto_closed_reason = 'הליד סומן כאבוד (LOST) — המעקב בוטל אוטומטית',
        updated_at = now()
    where lead_id = p_lead_id
      and status = 'PENDING';
  elsif p_new_stage <> 'NEW' then
    -- The lead is being actively handled — the new-lead AUTOMATIC task
    -- (and its one reminder, if unsent) is closed for good.
    update public.follow_up_tasks
    set status = 'CANCELLED',
        auto_closed_reason = 'נסגר אוטומטית — הליד כבר בטיפול',
        updated_at = now()
    where lead_id = p_lead_id
      and source = 'AUTOMATIC'
      and status = 'PENDING';
  end if;
end;
$$;

comment on function public.change_lead_stage(uuid, public.lead_stage, public.lead_lost_reason, text) is
  'Atomically changes a lead''s stage and records the transition. LOST '
  'requires a reason (OTHER also requires p_lost_reason_note); the reason '
  'and note are stored on the lead and on the stage event. LOST cancels '
  'every PENDING follow-up; any other non-NEW stage closes the PENDING '
  'AUTOMATIC task. WON is rejected (use convert_lead_to_won) and a WON lead '
  'cannot be moved to another stage.';

revoke all on function public.change_lead_stage(uuid, public.lead_stage, public.lead_lost_reason, text) from public;
grant execute on function public.change_lead_stage(uuid, public.lead_stage, public.lead_lost_reason, text) to authenticated;

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

  -- V2 guard: a lead that was WON before (and reopened under the old
  -- rules) already has its purchase — never create a second one.
  if exists (select 1 from public.purchases where lead_id = p_lead_id) then
    raise exception 'This lead already has a purchase' using errcode = 'GALW2';
  end if;

  select id into v_changed_by
  from public.app_users
  where auth_user_id = auth.uid();

  update public.leads
  set stage = 'WON',
      stage_changed_at = now(),
      lost_reason = null,
      lost_reason_note = null,
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

-- ============================================================
-- 6. Conversation tracking
-- ============================================================

create type public.lead_conversation_outcome as enum (
  'CALL_TOMORROW',
  'CALL_BACK_LATER',
  'WANTS_TRIAL',
  'REQUESTED_DETAILS',
  'NEEDS_TIME',
  'NUTRITION_INTEREST',
  'DETAILS_SENT_WHATSAPP',
  'NO_ANSWER',
  'OTHER'
);

create table public.lead_conversation_updates (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  outcome public.lead_conversation_outcome not null,
  note text,
  stage_before public.lead_stage not null,
  stage_after public.lead_stage not null,
  follow_up_task_id uuid references public.follow_up_tasks(id) on delete set null,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint lead_conversation_updates_other_requires_note
    check (outcome <> 'OTHER' or (note is not null and length(btrim(note)) > 0))
);

comment on table public.lead_conversation_updates is
  'Append-only, timestamped history of Gal''s conversation updates with a '
  'lead (outcome + free-text note), with the stage before/after and the '
  'MANUAL follow-up created from it, if any. Written only via '
  'record_lead_conversation(); never updated or overwritten.';

create index lead_conversation_updates_lead_idx
  on public.lead_conversation_updates (lead_id, created_at desc);

alter table public.lead_conversation_updates enable row level security;

create policy lead_conversation_updates_crm_select
  on public.lead_conversation_updates for select
  to authenticated
  using (public.is_crm_user());

create policy lead_conversation_updates_crm_insert
  on public.lead_conversation_updates for insert
  to authenticated
  with check (public.is_crm_user());

-- Append-only: no UPDATE/DELETE grant or policy for authenticated (lead
-- deletion removes rows via the FK cascade).
grant select, insert on public.lead_conversation_updates to authenticated;
-- The reminder cron reads the latest note for the email body.
grant select on public.lead_conversation_updates to service_role;

create or replace function public.record_lead_conversation(
  p_lead_id uuid,
  p_outcome public.lead_conversation_outcome,
  p_note text default null,
  p_new_stage public.lead_stage default null,
  p_follow_up_title text default null,
  p_follow_up_due_at timestamptz default null,
  p_follow_up_notes text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_stage_before public.lead_stage;
  v_stage_after public.lead_stage;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_task public.follow_up_tasks;
  v_task_id uuid;
  v_changed_by uuid;
  v_id uuid;
begin
  if p_new_stage in ('WON', 'LOST') then
    raise exception 'Use the dedicated WON/LOST flows for this stage' using errcode = 'GALC1';
  end if;
  if p_outcome = 'OTHER' and v_note is null then
    raise exception 'The OTHER outcome requires a note' using errcode = 'GALC2';
  end if;

  select stage into v_stage_before
  from public.leads
  where id = p_lead_id
  for update;

  if not found then
    raise exception 'Lead not found or not accessible';
  end if;

  if v_stage_before in ('WON', 'LOST') then
    raise exception 'Conversation updates are for open leads only' using errcode = 'GALC3';
  end if;

  -- "No answer" never marks the lead as successfully contacted: any
  -- requested stage change is ignored for that outcome.
  if p_new_stage is not null and p_new_stage <> v_stage_before and p_outcome <> 'NO_ANSWER' then
    perform public.change_lead_stage(p_lead_id, p_new_stage, null, null);
  end if;

  if p_follow_up_due_at is not null then
    select * into v_task from public.create_manual_follow_up_for_lead(
      p_lead_id,
      coalesce(nullif(btrim(coalesce(p_follow_up_title, '')), ''), 'שיחת המשך'),
      nullif(btrim(coalesce(p_follow_up_notes, '')), ''),
      p_follow_up_due_at
    );
    v_task_id := v_task.id;
  end if;

  select stage into v_stage_after from public.leads where id = p_lead_id;

  select id into v_changed_by
  from public.app_users
  where auth_user_id = auth.uid();

  insert into public.lead_conversation_updates (
    lead_id, outcome, note, stage_before, stage_after, follow_up_task_id, created_by
  )
  values (p_lead_id, p_outcome, v_note, v_stage_before, v_stage_after, v_task_id, v_changed_by)
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.record_lead_conversation(uuid, public.lead_conversation_outcome, text, public.lead_stage, text, timestamptz, text) is
  'Records one conversation update for an open lead in a single '
  'transaction: optional stage change (ignored for NO_ANSWER; WON/LOST '
  'rejected), optional MANUAL follow-up (via create_manual_follow_up_for_lead, '
  'so the one-current-manual rule and AUTOMATIC closing apply), and the '
  'append-only lead_conversation_updates row linking them.';

revoke all on function public.record_lead_conversation(uuid, public.lead_conversation_outcome, text, public.lead_stage, text, timestamptz, text) from public;
grant execute on function public.record_lead_conversation(uuid, public.lead_conversation_outcome, text, public.lead_stage, text, timestamptz, text) to authenticated;

-- ============================================================
-- 7. Atomic manual lead creation with duplicate warning
-- ============================================================

-- SQL mirror of lib/meta/normalize.ts normalizePhone.
create or replace function public.normalize_phone(p_raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when s.d is null or length(s.d) < 7 then null
    when left(s.d, 1) = '0' and length(s.d) between 9 and 10 then '972' || substr(s.d, 2)
    when left(s.d, 4) = '9720' and length(s.d) = 13 then '972' || substr(s.d, 5)
    else s.d
  end
  from (select nullif(regexp_replace(coalesce(p_raw, ''), '\D', '', 'g'), '') as d) s
$$;

revoke all on function public.normalize_phone(text) from public;
grant execute on function public.normalize_phone(text) to authenticated, service_role;

create or replace function public.create_lead_manually(
  p_full_name text,
  p_phone text,
  p_email text,
  p_instagram_username text,
  p_notes text,
  p_interested_services public.service_type[],
  p_channel public.touchpoint_channel,
  p_referrer_customer_id uuid,
  p_allow_duplicate boolean default false
)
returns table (
  lead_id uuid,
  contact_id uuid,
  duplicate_contact_id uuid,
  duplicate_contact_name text,
  duplicate_lead_id uuid
)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_name text := nullif(btrim(coalesce(p_full_name, '')), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_norm_phone text := public.normalize_phone(p_phone);
  v_norm_email text := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_dup_id uuid;
  v_dup_name text;
  v_dup_lead uuid;
  v_contact_id uuid;
  v_lead_id uuid;
begin
  if v_name is null then
    raise exception 'Full name is required' using errcode = 'GALM1';
  end if;

  if not coalesce(p_allow_duplicate, false) and (v_norm_phone is not null or v_norm_email is not null) then
    select c.id, c.full_name into v_dup_id, v_dup_name
    from public.contacts c
    where (v_norm_phone is not null and public.normalize_phone(c.phone) = v_norm_phone)
       or (v_norm_email is not null and lower(btrim(c.email)) = v_norm_email)
    order by c.created_at
    limit 1;

    if v_dup_id is not null then
      select l.id into v_dup_lead
      from public.leads l
      where l.contact_id = v_dup_id
      order by (l.stage not in ('WON', 'LOST')) desc, l.created_at desc
      limit 1;

      return query select null::uuid, null::uuid, v_dup_id, v_dup_name, v_dup_lead;
      return;
    end if;
  end if;

  insert into public.contacts (full_name, phone, email, instagram_username, notes)
  values (
    v_name, v_phone, v_email,
    nullif(btrim(coalesce(p_instagram_username, '')), ''),
    nullif(btrim(coalesce(p_notes, '')), '')
  )
  returning id into v_contact_id;

  insert into public.leads (contact_id)
  values (v_contact_id)
  returning id into v_lead_id;

  if p_interested_services is not null and cardinality(p_interested_services) > 0 then
    insert into public.lead_interested_services (lead_id, service_type)
    select distinct v_lead_id, s from unnest(p_interested_services) s;
  end if;

  if p_channel is not null then
    insert into public.touchpoints (lead_id, channel, certainty, is_primary)
    values (v_lead_id, p_channel, 'BROAD', true);
  end if;

  if p_channel = 'REFERRAL' and p_referrer_customer_id is not null then
    insert into public.referrals (referred_contact_id, referrer_customer_id)
    values (v_contact_id, p_referrer_customer_id);
  end if;

  return query select v_lead_id, v_contact_id, null::uuid, null::text, null::uuid;
end;
$$;

comment on function public.create_lead_manually(text, text, text, text, text, public.service_type[], public.touchpoint_channel, uuid, boolean) is
  'Creates a manual lead (contact, lead, interested services, primary '
  'touchpoint, referral) in ONE transaction. Unless p_allow_duplicate, an '
  'existing contact with the same normalized phone or email is returned as '
  'a warning (duplicate_* columns) and NOTHING is created — never an '
  'automatic merge.';

revoke all on function public.create_lead_manually(text, text, text, text, text, public.service_type[], public.touchpoint_channel, uuid, boolean) from public;
grant execute on function public.create_lead_manually(text, text, text, text, text, public.service_type[], public.touchpoint_channel, uuid, boolean) to authenticated;

-- ============================================================
-- 8. Meta ingestion: record whether a submission created a new lead
-- ============================================================

alter table public.meta_lead_ingestions
  add column created_new_lead boolean;

comment on column public.meta_lead_ingestions.created_new_lead is
  'True when this PROCESSED submission created a brand-new lead; false '
  'when it attached a touchpoint to the contact''s existing open lead. '
  'Null for rows processed before V2.';
