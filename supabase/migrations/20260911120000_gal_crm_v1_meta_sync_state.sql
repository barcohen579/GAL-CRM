-- GAL CRM V1 — Meta sync state (freshness + concurrency lock)
--
-- Records when the Meta campaign-spend sync (scripts/meta-sync.mjs, now also
-- reachable via app/api/meta/sync/trigger for the automatic Dashboard
-- refresh — see lib/meta/campaign-sync.ts / lib/meta/sync-orchestrator.ts)
-- last actually SUCCEEDED, and doubles as the server-side lock preventing
-- two concurrent syncs from ever running at once (opening several Dashboard
-- tabs, or Bar and Gal both opening the CRM at the same time, must trigger
-- at most one real Meta sync).
--
-- Deliberately a single-row table (source = 'META' is the only row this app
-- ever writes): there is exactly one Meta sync job, covering both
-- configured ad accounts (META_AD_ACCOUNT_IDS) together in one run, so one
-- freshness/lock record is the correct granularity — not one row per
-- account, not a generic multi-integration job-run table. See the task's
-- own "keep this simple; do not build an unnecessary generic job
-- framework" guidance.
--
-- Locking model:
-- The claim is a single atomic `UPDATE ... WHERE status <> 'running' OR
-- last_attempt_started_at < <stale threshold> RETURNING *` (see
-- lib/meta/sync-state-repo.ts::claimRun) — the exact same "one UPDATE...
-- WHERE, no advisory lock, Postgres's own row lock serializes concurrent
-- callers" shape already used and tested for the Meta lead-ingestion
-- pipeline (lib/meta/repo.ts::claimForProcessing,
-- lib/meta/concurrency.test.ts). A row stuck in 'running' past the stale
-- threshold (crashed mid-sync) becomes reclaimable rather than wedging
-- freshness forever.
--
-- Freshness model:
-- Freshness is ONLY ever read from last_success_at — never inferred from
-- the latest metric_date present in meta_campaign_daily_metrics or from
-- whether today's row exists, because Meta can still revise a day's
-- already-synced spend without a new sync having run (see that table's own
-- migration comment on this exact point).

create table public.meta_sync_state (
  source text primary key,
  status text not null default 'idle'
    check (status in ('idle', 'running', 'success', 'failed')),
  last_attempt_started_at timestamptz,
  last_attempt_finished_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

comment on table public.meta_sync_state is
  'Freshness + concurrency-lock state for the Meta campaign-spend sync. '
  'Exactly one row (source = ''META''), covering both configured ad '
  'accounts together. last_success_at is the only source of truth for '
  '"how fresh is Meta spend" — never inferred from metric_date.';

comment on column public.meta_sync_state.status is
  'idle: seed/never attempted. running: currently syncing (the lock). '
  'success/failed: outcome of the most recent attempt. A failed attempt '
  'never touches last_success_at.';

comment on column public.meta_sync_state.last_error is
  'Sanitized, human-readable failure reason only — never a raw token, '
  'stack trace, or Meta API payload. See lib/meta/sync-state-repo.ts.';

-- Seed the one row this app ever uses. The Dashboard/route handlers rely on
-- this row always existing (an atomic UPDATE...WHERE claim has nothing to
-- claim against an absent row) — never left to be created lazily by app
-- code.
insert into public.meta_sync_state (source) values ('META')
  on conflict (source) do nothing;

create trigger set_updated_at
  before update on public.meta_sync_state
  for each row execute function public.set_updated_at();

-- ============================================================
-- Row Level Security
-- ============================================================

alter table public.meta_sync_state enable row level security;

create policy meta_sync_state_crm_select
  on public.meta_sync_state for select
  to authenticated
  using (public.is_crm_user());

-- Deliberately no insert/update/delete policy for `authenticated` — same
-- "authenticated users have no legitimate reason to hand-edit sync state"
-- philosophy as meta_campaign_daily_metrics. Writes happen only via
-- service_role (the trigger route / cron), which bypasses RLS entirely.

grant select on public.meta_sync_state to authenticated;

-- This project disables automatic default grants on new tables (see
-- 20260902223944_gal_crm_v1_meta_metrics_service_role_grant.sql for the
-- same fix applied to meta_campaign_daily_metrics) — service_role needs an
-- explicit grant too, or the claim/mark UPDATEs fail with 42501 before RLS
-- is ever reached. No delete: this table is never deleted from.
grant select, insert, update on public.meta_sync_state to service_role;
