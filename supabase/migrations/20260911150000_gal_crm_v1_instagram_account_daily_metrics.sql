-- GAL CRM V1 — Instagram account daily follower snapshot
--
-- Real, live investigation (read-only calls against the production Meta
-- Graph API, using GAL-CRM's own META_ACCESS_TOKEN) confirmed: Meta does
-- NOT expose paid-attributed Instagram follows for any campaign/adset/ad
-- in this account (the `actions` field for the current live engagement
-- campaign contains only link_click/post_engagement/like/page_engagement/
-- video_view — no follow-shaped action_type at any level), and Meta's
-- own Instagram Insights follower_count history is not permitted for
-- this token (#10 permission error). So there is no genuine per-campaign
-- follower metric to show, and no existing historical follower time
-- series to fall back to either.
--
-- What IS confirmed working: a plain
-- GET /{ig-user-id}?fields=id,username,followers_count succeeds with the
-- SAME existing token (no new secret). This table lets GAL-CRM start
-- collecting a genuine daily snapshot of that number GOING FORWARD —
-- never backfilled/fabricated for days before this migration — reused by
-- lib/meta/instagram-follower-sync.ts to compute an explicitly
-- non-attributed "שינוי עוקבים בתקופת הפרסום" (account-wide, not
-- campaign-attributed) once enough days of real snapshots exist.
--
-- One row per real Israel-calendar day (metric_date is the primary key),
-- upserted — safe to sync more than once a day, always keeps that day's
-- latest read, mirrors meta_campaign_daily_metrics' own idempotency
-- shape. Populated only by service_role, from the same trigger route the
-- Meta campaign-spend sync already uses (no new cron, no new lock).

create table public.instagram_account_daily_metrics (
  metric_date date primary key,
  ig_user_id text not null,
  follower_count integer not null check (follower_count >= 0),
  fetched_at timestamptz not null default now()
);

comment on table public.instagram_account_daily_metrics is
  'Daily snapshot of the Instagram account''s current follower_count '
  '(account-wide, never campaign-attributed — Meta does not expose '
  'paid-attributed follows for this account/token, confirmed via a live '
  'API audit). Populated going forward only; never backfilled.';

comment on column public.instagram_account_daily_metrics.follower_count is
  'A real snapshot read from Meta''s own /{ig-user-id}?fields=followers_count '
  'at fetched_at — never interpolated or estimated.';

-- ============================================================
-- Row Level Security
-- ============================================================

alter table public.instagram_account_daily_metrics enable row level security;

create policy instagram_account_daily_metrics_crm_select
  on public.instagram_account_daily_metrics for select
  to authenticated
  using (public.is_crm_user());

-- Deliberately no insert/update/delete policy for `authenticated` — same
-- "only the trusted sync job writes this" philosophy as
-- meta_campaign_daily_metrics and meta_sync_state.

grant select on public.instagram_account_daily_metrics to authenticated;

-- This project disables automatic default grants on new tables — see
-- 20260902223944_gal_crm_v1_meta_metrics_service_role_grant.sql for the
-- same fix already applied to meta_campaign_daily_metrics.
grant select, insert, update on public.instagram_account_daily_metrics to service_role;
