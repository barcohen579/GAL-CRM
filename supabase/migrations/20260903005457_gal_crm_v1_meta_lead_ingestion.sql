-- GAL CRM V1 — Meta Lead Ads ingestion foundation (Phase 3B)
--
-- Server-side foundation for receiving real Meta Lead Ads webhooks
-- later. This migration adds ONLY the durable ingestion audit table,
-- one small touchpoints schema extension, and the grants the trusted
-- server-only webhook route + reprocessing script need. It does NOT
-- configure or subscribe anything in Meta — that remains a separate,
-- later, manual step (see the route's own comments).
--
-- Ownership boundary (same principle as touchpoints and
-- meta_campaign_daily_metrics — see their own migrations): this table
-- is CRM ingestion bookkeeping owned by GAL CRM. It is never a copy of,
-- and never writes back to, the separate Instagram/content-intelligence
-- MCP.
--
-- Write model:
-- meta_lead_ingestions and the CRM tables it feeds (contacts, leads,
-- touchpoints) are written EXCLUSIVELY by the trusted server-only
-- webhook route (app/api/meta/leadgen-webhook/route.ts) and its
-- reprocessing script (scripts/meta-reprocess-lead.ts), both
-- authenticating with the Supabase service_role key — never exposed to
-- the browser. Normal authenticated CRM users get SELECT-only on
-- meta_lead_ingestions (for visibility/debugging in a future admin
-- view) — no INSERT/UPDATE/DELETE grant or policy exists for
-- `authenticated` at all, deliberately: this is ingestion bookkeeping,
-- not CRM-authored data, and a logged-in user has no legitimate reason
-- to hand-edit it. This mirrors meta_campaign_daily_metrics's
-- "deliberately no write policy of any kind for `authenticated`".
--
-- Idempotency:
-- leadgen_id is the canonical idempotency key (unique, not null) — one
-- row per Meta lead submission, regardless of how many times Meta
-- redelivers the webhook. The application-level flow (see
-- lib/meta/ingest.ts) additionally checks for an existing touchpoint
-- with external_ref = leadgen_id before creating any CRM entity, so a
-- duplicate delivery can never create a duplicate Contact, Lead, or
-- Touchpoint even if a previous attempt crashed partway through.
--
-- raw_payload minimization:
-- Meta's leadgen webhook "value" object itself never contains lead
-- answers/PII — only ids and a timestamp (leadgen_id, page_id, form_id,
-- adgroup_id, ad_id, campaign_id, created_time). The actual submitted
-- answers (field_data — name/phone/email/...) require a separate,
-- authenticated Graph API call and are NEVER persisted here. This
-- column exists purely for webhook-shape debugging/idempotency, so
-- storing the verbatim (PII-free) webhook value is safe and keeps
-- future retention/cleanup trivial (this table can be pruned/rebuilt
-- from Meta at any time — it holds no data that doesn't also exist,
-- more completely, in Meta itself).

-- ============================================================
-- Status enum
-- ============================================================

create type public.meta_lead_ingestion_status as enum (
  'PENDING',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
  'DUPLICATE_IGNORED'
);

-- ============================================================
-- meta_lead_ingestions
-- ============================================================

create table public.meta_lead_ingestions (
  id uuid primary key default gen_random_uuid(),
  leadgen_id text not null unique,
  meta_page_id text not null,
  meta_form_id text,
  meta_ad_id text,
  meta_adset_id text,
  meta_campaign_id text,
  received_at timestamptz not null,
  processed_at timestamptz,
  status public.meta_lead_ingestion_status not null default 'PENDING',
  error_message text,
  contact_id uuid references public.contacts(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  touchpoint_id uuid references public.touchpoints(id) on delete set null,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meta_lead_ingestions_processed_at_consistency check (
    (status in ('PROCESSED', 'DUPLICATE_IGNORED') and processed_at is not null)
    or (status not in ('PROCESSED', 'DUPLICATE_IGNORED'))
  )
);

comment on table public.meta_lead_ingestions is
  'Durable, idempotent audit trail of every Meta Lead Ads webhook delivery, '
  'keyed on leadgen_id. Written exclusively by the server-only webhook route '
  'and its reprocessing script via service_role. raw_payload holds only the '
  'PII-free webhook envelope (ids + timestamp) — never field_data/lead answers.';

comment on column public.meta_lead_ingestions.leadgen_id is
  'Canonical idempotency key — Meta''s unique id for one lead submission. '
  'A redelivered webhook for the same leadgen_id reuses this row, never a new one.';

comment on column public.meta_lead_ingestions.meta_adset_id is
  'Meta calls this "adgroup_id" in both the webhook payload and the Graph API '
  'lead-detail response; stored here under the more common "adset" naming.';

comment on column public.meta_lead_ingestions.raw_payload is
  'The verbatim, PII-free webhook "value" object (ids + created_time only). '
  'Never contains field_data / submitted lead answers — see migration notes.';

create index meta_lead_ingestions_status_idx
  on public.meta_lead_ingestions (status);

create index meta_lead_ingestions_received_at_idx
  on public.meta_lead_ingestions (received_at);

-- Supports the reprocessing script's "find retryable rows" query
-- without scanning PROCESSED/DUPLICATE_IGNORED history.
create index meta_lead_ingestions_retryable_idx
  on public.meta_lead_ingestions (received_at)
  where status in ('PENDING', 'FAILED');

create trigger set_updated_at
  before update on public.meta_lead_ingestions
  for each row execute function public.set_updated_at();

-- ============================================================
-- touchpoints — smallest sensible extension for Meta source metadata
--
-- The existing touchpoints table (core schema migration) already has
-- external_ref (used here for leadgen_id) and source_detail (a short
-- human-readable label). Neither is a good place for MULTIPLE
-- structured Meta ids (form/ad/adset/campaign/page) at once, and none
-- of the existing columns are Meta-specific — adding five Meta-named
-- columns would be over-fitted to one channel. A single generic
-- `metadata jsonb` column is the smallest extension that fits: it
-- holds Meta's ids today, and is equally available to any future
-- channel that needs structured (not just free-text) attribution
-- detail — without duplicating the Instagram content-intelligence
-- system, which remains the separate source of truth for organic
-- content/DM/comment data.
-- ============================================================

alter table public.touchpoints add column metadata jsonb;

comment on column public.touchpoints.metadata is
  'Optional structured, channel-specific attribution metadata (e.g. Meta '
  'pageId/formId/adId/adsetId/campaignId). Free-form JSON, never a '
  'duplication of Instagram MCP content or analytics.';

-- ============================================================
-- Row Level Security
-- ============================================================

alter table public.meta_lead_ingestions enable row level security;

create policy meta_lead_ingestions_crm_select
  on public.meta_lead_ingestions for select
  to authenticated
  using (public.is_crm_user());

-- Deliberately no insert/update/delete policy for `authenticated` — see
-- "Write model" note above. Writes happen only via service_role (the
-- webhook route / reprocessing script), which bypasses RLS entirely,
-- and via the migration/owner role. No DELETE grant/policy exists for
-- ANY role in this migration — retention/cleanup of old ingestion rows
-- is deliberately left as a separate, later, explicit decision.

grant select on public.meta_lead_ingestions to authenticated;

-- ============================================================
-- service_role grants
--
-- This project has automatic-RLS-with-default-grants disabled at
-- creation time (see 20260902111440_gal_crm_v1_authenticated_table_grants.sql
-- and 20260902223944_gal_crm_v1_meta_metrics_service_role_grant.sql for
-- the established precedent) — a newly created table, and service_role
-- on any EXISTING table, gets no privileges by default. service_role's
-- BYPASSRLS attribute only skips RLS policies, not the base GRANT
-- check Postgres performs first. Grants below are exactly what the
-- webhook route + reprocessing script's application-level ingestion
-- logic (lib/meta/ingest.ts) needs and no more — no SQL function does
-- this work with elevated privileges, so every table it touches needs
-- an explicit grant here:
--
--   meta_lead_ingestions -> SELECT, INSERT, UPDATE (find-or-create the
--                           row, claim it for processing, record the
--                           outcome). No DELETE — see above.
--   contacts              -> SELECT (phone/email match candidates),
--                           INSERT (new contact), UPDATE (fill-in-only
--                           for missing phone/email on a matched
--                           contact — never overwrites existing data).
--   leads                 -> SELECT (find an existing OPEN lead for the
--                           matched contact), INSERT (new lead, only
--                           when no OPEN lead exists). No UPDATE — the
--                           ingestion path never changes a lead's stage.
--   touchpoints            -> SELECT (idempotency check by external_ref,
--                           "does this lead already have a touchpoint"),
--                           INSERT (the one touchpoint per leadgen_id).
--                           No UPDATE/DELETE.
-- ============================================================

grant select, insert, update on public.meta_lead_ingestions to service_role;

grant select, insert, update on public.contacts to service_role;

grant select, insert on public.leads to service_role;

grant select, insert on public.touchpoints to service_role;
