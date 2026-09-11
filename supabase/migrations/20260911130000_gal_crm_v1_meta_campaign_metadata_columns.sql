-- GAL CRM V1 — Meta campaign identification: objective / effective_status
--
-- Additive extension to meta_campaign_daily_metrics. Real, Meta-returned
-- campaign metadata (the Campaign object's own `objective` and
-- `effective_status` fields — see lib/meta/campaign-sync.ts::
-- fetchCampaignsMetadata), fetched once per account alongside the
-- existing per-day Insights sync, so "ביצועי קמפיינים" on the Dashboard
-- can show which promotion a row actually is (Bar/Gal could previously
-- only see a truncated campaign_name).
--
-- Deliberately plain nullable text, no enum/CHECK constraint: Meta adds
-- new objective values over time and this table has never tried to be
-- the source of truth for what Meta's own enums are — same reasoning
-- already applied to campaign_name on this same table. Nullable because
-- the metadata fetch is a secondary, best-effort enrichment call (see
-- syncOneAccount's own try/catch around it) — a row must never be
-- blocked from being upserted just because this call failed.
--
-- No change to the table's identity/upsert key
-- (meta_ad_account_id, campaign_id, metric_date) — these two columns
-- are refreshed on every re-sync exactly like campaign_name already is,
-- via the same ON CONFLICT ... DO UPDATE upsert.

alter table public.meta_campaign_daily_metrics
  add column objective text,
  add column effective_status text;

comment on column public.meta_campaign_daily_metrics.objective is
  'The Campaign object''s own objective (e.g. OUTCOME_ENGAGEMENT, '
  'OUTCOME_LEADS), as returned by Meta''s /campaigns endpoint. Null when '
  'the metadata enrichment fetch didn''t cover this campaign_id.';

comment on column public.meta_campaign_daily_metrics.effective_status is
  'The Campaign object''s own effective_status (e.g. ACTIVE, PAUSED), '
  'as returned by Meta''s /campaigns endpoint. Null when the metadata '
  'enrichment fetch didn''t cover this campaign_id.';
