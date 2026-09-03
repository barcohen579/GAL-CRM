-- GAL CRM V1 — DB-level uniqueness guarantee for Meta touchpoints
-- (Phase 3C: production-readiness / security audit follow-up)
--
-- Audit finding: Phase 3B's "exactly one touchpoint per leadgen_id"
-- guarantee lived ENTIRELY in application code (lib/meta/ingest.ts's
-- findTouchpointByExternalRef check). That check is real protection —
-- but it is a read-then-write pattern, not an atomic database
-- constraint, so it is only as strong as the surrounding concurrency
-- control. This migration adds the actual database-level guarantee so
-- a duplicate META_AD touchpoint for the same leadgen_id is IMPOSSIBLE
-- regardless of any future bug, race, or new code path — not just
-- unlikely.
--
-- Verified live before writing this migration (read-only query) that
-- no existing touchpoints already violate this constraint:
--   select external_ref, count(*) from public.touchpoints
--   where channel = 'META_AD' and external_ref is not null
--   group by external_ref having count(*) > 1;
-- returned zero rows.
--
-- Scope/safety for existing (non-Meta) touchpoints:
--   - The index is PARTIAL (WHERE channel = 'META_AD') — every
--     touchpoint on every other channel (INSTAGRAM_DM, REFERRAL, ...)
--     is completely unaffected, duplicate/null external_ref and all.
--   - Postgres unique indexes never consider NULL values equal to each
--     other, so any number of manually-created META_AD touchpoints
--     with external_ref = NULL (e.g. from the existing manual
--     "create lead with channel" UI flow, which never sets
--     external_ref) remain entirely unaffected — this constraint only
--     ever fires for two META_AD touchpoints sharing the same
--     NON-NULL external_ref (i.e. the same Meta leadgen_id).
--
-- This is intentionally the smallest fix: one partial unique index,
-- no new table, no new column, no behavior change for any existing
-- touchpoint or any non-Meta channel.

create unique index touchpoints_meta_ad_external_ref_key
  on public.touchpoints (external_ref)
  where channel = 'META_AD' and external_ref is not null;

comment on index public.touchpoints_meta_ad_external_ref_key is
  'DB-level guarantee that a Meta leadgen_id (external_ref) can back at '
  'most one META_AD touchpoint. Application code (lib/meta/ingest.ts) '
  'already checks this before inserting; this index makes the guarantee '
  'unconditional rather than dependent on that check running first.';
