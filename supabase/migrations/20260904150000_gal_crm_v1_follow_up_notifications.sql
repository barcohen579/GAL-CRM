-- GAL CRM V1 — follow-up notification delivery tracking
--
-- Adds the minimum persistence needed to email Gal a reminder when a
-- follow_up_tasks row comes due, and a once-daily digest of the day's
-- pending follow-ups — without ever emailing the same reminder twice,
-- and without ever claiming a delivery "succeeded" before the email
-- provider actually confirmed it. This migration is delivery-tracking
-- ONLY: it never changes follow_up_tasks' own columns, statuses, or
-- any of its existing create/complete/cancel behavior.
--
-- ============================================================
-- DESIGN — conceptually mirrors the recurring-billing/recurring-
-- expense idempotency pattern (claim -> external I/O -> record
-- result), adapted for the one respect in which sending an email is
-- fundamentally different from generating a payment/expense row: a
-- payment INSERT is pure SQL, entirely atomic inside one transaction.
-- An email send is an HTTP call to a third party that cannot happen
-- inside a SQL function at all — the "claim" and "record the result"
-- steps must be separate round trips from application code (see
-- app/api/cron/follow-up-notifications/route.ts). The unique
-- constraint + conditional UPDATE below is what keeps that safe even
-- so: a delivery can only ever be claimed once at a time, whether the
-- cron runs concurrently or is simply invoked again before the first
-- run finished.
--
-- follow_up_reminder_deliveries — one row per follow_up_tasks row,
--   ALWAYS pre-created in status = 'PENDING' by a trigger the moment
--   the task is created (see create_follow_up_reminder_delivery()
--   below) — so "pending" is a real, always-present, queryable state
--   for every follow-up, not merely "no row exists yet". The cron
--   claims a due one by flipping PENDING/FAILED -> SENDING (a plain
--   conditional UPDATE ... WHERE status IN (...) RETURNING id is
--   already atomic per row; a second, concurrent attempt to claim the
--   same row simply updates 0 rows and gets nothing back). Only after
--   the provider confirms success does status become SENT; only after
--   a confirmed failure does it become FAILED (with attempt_count/
--   last_error recorded for safe, bounded retry — see the cron route's
--   own MAX_ATTEMPTS/backoff constants). A completed/cancelled
--   follow-up is never claimed regardless of its delivery row's own
--   status: the cron always joins back to follow_up_tasks and requires
--   status = 'PENDING' there too — a deliberate simplification over
--   also flipping the delivery row to some "skipped" state when the
--   task closes, since the join-based filter already fully prevents
--   ever sending it (see this migration's own header for why that
--   extra bookkeeping isn't needed).
--
-- daily_digest_deliveries — one row per Israel CALENDAR DATE the
--   digest was attempted for (never per follow-up: the digest is one
--   email listing several). Digest dates have no natural "creation
--   event" to hang a trigger on the way a follow-up task does, so this
--   is claimed via claim_daily_digest_send() (INSERT ... ON CONFLICT
--   (digest_date) DO UPDATE ... WHERE status = 'FAILED' ... RETURNING)
--   — the standard Postgres idiom for "create if absent, else
--   conditionally reclaim for retry, atomically, in one statement".
--   SKIPPED_EMPTY is a real, distinct terminal status (not FAILED, not
--   left unset) — deliberately sending nothing when there is nothing
--   to report is still a completed decision for that day, so it must
--   never be re-attempted on a later cron tick the same day.
--
-- Neither table has ANY RLS policy for `authenticated` (zero policies
-- = zero access, same "RLS enabled, no policies" pattern as
-- app_users) — these are pure server-automation state, touched only by
-- the cron's service_role admin client, never by a normal CRM session
-- or the browser, and never by the "הוספת מעקב"/"סימון כהושלם"/
-- "ביטול מעקב" Server Actions in app/(app)/follow-ups/actions.ts,
-- which are entirely unaffected by this migration.
--
-- last_error is free text but MUST NEVER contain a secret — the email
-- provider adapter (lib/notifications/providers/resend.ts) only ever
-- surfaces the HTTP response body/status from the provider, never the
-- outgoing Authorization header, so there is nothing secret to leak
-- through this column by construction.

create type public.follow_up_reminder_status as enum (
  'PENDING',
  'SENDING',
  'SENT',
  'FAILED'
);

create table public.follow_up_reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  follow_up_task_id uuid not null unique references public.follow_up_tasks(id) on delete cascade,
  status public.follow_up_reminder_status not null default 'PENDING',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempted_at timestamptz,
  last_error text,
  provider_message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint follow_up_reminder_deliveries_sent_at_requires_sent
    check ((status = 'SENT') = (sent_at is not null))
);

comment on table public.follow_up_reminder_deliveries is
  'Delivery-tracking ledger for the individual follow-up reminder '
  'email, one row per follow_up_tasks row (pre-created PENDING by a '
  'trigger at task-creation time). Never marks SENT until the email '
  'provider actually confirms submission. Server/cron-only — no RLS '
  'policy grants `authenticated` any access.';

create index follow_up_reminder_deliveries_status_idx
  on public.follow_up_reminder_deliveries (status);

create trigger set_updated_at
  before update on public.follow_up_reminder_deliveries
  for each row execute function public.set_updated_at();

alter table public.follow_up_reminder_deliveries enable row level security;
-- Deliberately zero policies — see this migration's own header.

create type public.digest_delivery_status as enum (
  'SENDING',
  'SENT',
  'SKIPPED_EMPTY',
  'FAILED'
);

create table public.daily_digest_deliveries (
  id uuid primary key default gen_random_uuid(),
  -- The Israel CALENDAR date this digest is FOR (computed via
  -- lib/crm/timezone.ts's zonedParts, never the server's own local
  -- date) — the sole idempotency key: at most one digest per Israel
  -- calendar day, full stop, enforced by the unique constraint below.
  digest_date date not null unique,
  status public.digest_delivery_status not null default 'SENDING',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempted_at timestamptz not null default now(),
  last_error text,
  provider_message_id text,
  -- How many follow-ups were included — observability only, never
  -- used for any decision (SKIPPED_EMPTY is its own status, not
  -- inferred from this being 0).
  follow_up_count integer,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_digest_deliveries_sent_at_requires_sent
    check ((status = 'SENT') = (sent_at is not null))
);

comment on table public.daily_digest_deliveries is
  'Delivery-tracking ledger for the once-per-Israel-calendar-day '
  'digest email. digest_date is the sole idempotency key (unique) — '
  'claimed atomically via claim_daily_digest_send(). Server/cron-only '
  '— no RLS policy grants `authenticated` any access.';

create trigger set_updated_at
  before update on public.daily_digest_deliveries
  for each row execute function public.set_updated_at();

alter table public.daily_digest_deliveries enable row level security;
-- Deliberately zero policies — see this migration's own header.

-- ============================================================
-- create_follow_up_reminder_delivery — auto-creates the PENDING
-- delivery row for every new follow-up, regardless of how it was
-- created (MANUAL today, any future AI_SUGGESTED path too) — a
-- trigger rather than app-code discipline, matching this schema's own
-- established preference for DB-enforced invariants (e.g.
-- touchpoints_one_primary_per_lead, prevent_payment_fact_changes)
-- over trusting every future call site to remember.
--
-- SECURITY DEFINER: `authenticated` has (and must keep having) ZERO
-- grants on follow_up_reminder_deliveries — this trigger's own INSERT
-- into it must not be blocked by that. The narrow, audited-by-being-a-
-- trigger-only escalation this needs is exactly delete_lead_safely's
-- own precedent and reasoning. (Note: even without SECURITY DEFINER,
-- Postgres already refuses to invoke a `returns trigger` function via
-- any direct RPC/SQL call — "trigger functions can only be called as
-- triggers" — so revoking EXECUTE from public/authenticated below is
-- redundant defense-in-depth, not the actual protection; matches this
-- migration set's existing habit of keeping that revoke anyway.)
-- ============================================================

create or replace function public.create_follow_up_reminder_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.follow_up_reminder_deliveries (follow_up_task_id, status)
  values (new.id, 'PENDING');
  return new;
end;
$$;

comment on function public.create_follow_up_reminder_delivery() is
  'AFTER INSERT trigger on follow_up_tasks: creates the PENDING '
  'reminder-delivery row every follow-up needs, regardless of source. '
  'SECURITY DEFINER — see this function''s own comment above.';

revoke all on function public.create_follow_up_reminder_delivery() from public;
revoke all on function public.create_follow_up_reminder_delivery() from authenticated;

create trigger create_reminder_delivery
  after insert on public.follow_up_tasks
  for each row execute function public.create_follow_up_reminder_delivery();

-- ============================================================
-- claim_daily_digest_send — atomic "create if absent, else
-- conditionally reclaim for retry" for a given Israel calendar date.
-- Returns the claimed row's id, or no rows at all if not claimed
-- (already SENT/SKIPPED_EMPTY/SENDING that day, or too many failed
-- attempts already). SECURITY INVOKER: the only intended caller is
-- service_role, which already has exactly the table grants this needs
-- (below) — no elevation required, matching
-- generate_due_recurring_payments()'s own INVOKER choice and reasoning.
-- ============================================================

create or replace function public.claim_daily_digest_send(
  p_digest_date date,
  p_max_attempts integer default 5
)
returns table (claimed_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.daily_digest_deliveries (digest_date, status, attempt_count, last_attempted_at)
  values (p_digest_date, 'SENDING', 1, now())
  on conflict (digest_date) do update
    set status = 'SENDING',
        attempt_count = public.daily_digest_deliveries.attempt_count + 1,
        last_attempted_at = now()
    where public.daily_digest_deliveries.status = 'FAILED'
      and public.daily_digest_deliveries.attempt_count < p_max_attempts
  returning id into v_id;

  if v_id is null then
    return;
  end if;

  claimed_id := v_id;
  return next;
end;
$$;

comment on function public.claim_daily_digest_send(date, integer) is
  'Atomically claims (or creates) the daily_digest_deliveries row for '
  'p_digest_date, flipping it to SENDING — but ONLY when no row exists '
  'yet, or the existing row is FAILED with attempt_count still under '
  'p_max_attempts. Returns zero rows when not claimed (already sent, '
  'skipped-empty, mid-flight, or exhausted retries) — the caller must '
  'check for an empty result before sending anything. Called only by '
  'service_role via app/api/cron/follow-up-notifications/route.ts.';

revoke all on function public.claim_daily_digest_send(date, integer) from public;
revoke all on function public.claim_daily_digest_send(date, integer) from authenticated;
grant execute on function public.claim_daily_digest_send(date, integer) to service_role;

-- ============================================================
-- service_role grants — this project has automatic-RLS-with-default-
-- grants disabled (see 20260903005457_..._meta_lead_ingestion.sql for
-- the established precedent), so service_role gets no privileges here
-- until explicitly granted. Exactly what the cron route needs, no
-- more:
--
--   follow_up_tasks              -> SELECT only (find due candidates;
--                                    never inserts/updates/deletes a
--                                    follow-up itself).
--   follow_up_reminder_deliveries -> SELECT, UPDATE (claim + record
--                                    result). No INSERT — every row is
--                                    created by the trigger above, not
--                                    by the cron. No DELETE.
--   daily_digest_deliveries      -> SELECT, INSERT, UPDATE (the claim
--                                    function itself runs as the
--                                    caller — service_role — and needs
--                                    these directly). No DELETE.
--   customers                    -> SELECT only (resolve a
--                                    customer-linked follow-up's
--                                    contact name for the email).
--                                    leads and contacts already have a
--                                    service_role SELECT grant from the
--                                    Meta ingestion migration — reused
--                                    here, not re-granted.
-- ============================================================

grant select on public.follow_up_tasks to service_role;
grant select, update on public.follow_up_reminder_deliveries to service_role;
grant select, insert, update on public.daily_digest_deliveries to service_role;
grant select on public.customers to service_role;
