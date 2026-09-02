-- GAL CRM V1 — Meta campaign daily performance (paid-media metrics)
--
-- Phase 1 of Meta Marketing API integration: a single, read-focused table
-- for daily campaign-level ad performance (spend/impressions/reach/
-- clicks). No lead ingestion, no ad/adset-level detail, no cron/webhook
-- wiring — those are later phases. This migration is schema + RLS only.
--
-- Ownership boundary (same principle as touchpoints — see core schema):
-- this table is paid-media SPEND/PERFORMANCE data owned by GAL CRM. It is
-- never a copy of, and never writes back to, the separate Instagram/
-- content-intelligence MCP, which remains the source of truth for
-- organic content, DM/comment intelligence and the sales copilot. The
-- only relationship between the two is that both ultimately trace back
-- to the same Meta Business account — there is no shared table.
--
-- Write model:
-- This table is populated EXCLUSIVELY by a trusted, server-only sync
-- job (scripts/meta-sync.mjs) authenticating with the Supabase
-- service_role key (never exposed to the browser, never used in
-- lib/supabase/client.ts or server.ts). Normal authenticated CRM users
-- get SELECT only — no INSERT/UPDATE/DELETE grant or policy exists for
-- `authenticated` at all, deliberately: unlike CRM-authored data (leads,
-- follow-ups, ...), a logged-in user has no legitimate reason to write
-- ad-spend figures by hand, and allowing it would let a compromised
-- session fabricate financial reporting data. This mirrors the
-- `payments` table's "deliberately no delete policy" philosophy, taken
-- one step further here to "deliberately no write policy of any kind
-- for `authenticated`".
--
-- Idempotency:
-- One row per (meta_ad_account_id, campaign_id, metric_date) — enforced
-- by a unique constraint the sync job upserts against
-- (on conflict ... do update), so re-running a sync for a date already
-- stored updates that row in place rather than duplicating it. This is
-- required because Meta's own reported numbers for a given day can
-- still change for some time after that day completes (attribution/
-- reporting updates) — the sync is expected to routinely re-fetch a
-- trailing window, not just "yesterday".

create table public.meta_campaign_daily_metrics (
  id uuid primary key default gen_random_uuid(),
  meta_ad_account_id text not null,
  campaign_id text not null,
  campaign_name text,
  metric_date date not null,
  spend_minor integer not null default 0,
  impressions integer not null default 0,
  reach integer not null default 0,
  clicks integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meta_campaign_daily_metrics_unique
    unique (meta_ad_account_id, campaign_id, metric_date),
  constraint meta_campaign_daily_metrics_spend_minor_nonneg
    check (spend_minor >= 0),
  constraint meta_campaign_daily_metrics_impressions_nonneg
    check (impressions >= 0),
  constraint meta_campaign_daily_metrics_reach_nonneg
    check (reach >= 0),
  constraint meta_campaign_daily_metrics_clicks_nonneg
    check (clicks >= 0)
);

comment on table public.meta_campaign_daily_metrics is
  'Daily Meta (Facebook/Instagram) Ads campaign-level performance: spend '
  '(integer agorot, matching the CRM money convention), impressions, '
  'reach, clicks. One row per ad account + campaign + day — upserted by '
  'the server-only sync job, never written by authenticated CRM users.';

comment on column public.meta_campaign_daily_metrics.meta_ad_account_id is
  'Meta ad account id in "act_..." form, as returned by the Marketing API.';

comment on column public.meta_campaign_daily_metrics.campaign_id is
  'Meta campaign id. Stored as text — Meta ids exceed safe-integer range '
  'and are opaque identifiers, never arithmetic.';

comment on column public.meta_campaign_daily_metrics.spend_minor is
  'Spend in integer minor units (agorot for ILS), converted from Meta''s '
  'decimal string amount. Never a float.';

-- Query patterns this supports: "spend across all campaigns in a date
-- range" (metric_date-led index) and "history of one campaign over
-- time" (campaign_id-led index). The unique constraint above already
-- provides an (account, campaign, date) index for the exact upsert-key
-- lookup the sync job performs.
create index meta_campaign_daily_metrics_date_idx
  on public.meta_campaign_daily_metrics (metric_date, meta_ad_account_id);

create index meta_campaign_daily_metrics_campaign_idx
  on public.meta_campaign_daily_metrics (campaign_id, metric_date);

create trigger set_updated_at
  before update on public.meta_campaign_daily_metrics
  for each row execute function public.set_updated_at();

-- ============================================================
-- Row Level Security
-- ============================================================

alter table public.meta_campaign_daily_metrics enable row level security;

create policy meta_campaign_daily_metrics_crm_select
  on public.meta_campaign_daily_metrics for select
  to authenticated
  using (public.is_crm_user());

-- Deliberately no insert/update/delete policy for `authenticated` — see
-- "Write model" note above. Writes happen only via service_role (the
-- sync job), which bypasses RLS entirely, and via the migration/owner
-- role.

grant select on public.meta_campaign_daily_metrics to authenticated;
-- Deliberately no insert/update/delete grant for `authenticated`.
