-- GAL CRM — immediate "new lead" email notification bookkeeping +
-- bounded retry for a temporarily-failed send.
--
-- Problem this closes: Gal was not notified by email when a new Meta
-- lead arrived — the ONLY email-sending code path in this codebase is
-- the next-day AUTOMATIC follow-up escalation (see
-- app/api/cron/follow-up-notifications/route.ts /
-- supabase/migrations/20260904161000_..._automatic_lead_followup_escalation.sql),
-- which by design does not fire until the next eligible business day at
-- 10:00 Israel time. That next-day mechanism is deliberately left
-- untouched by this migration and everything built on top of it — this
-- is a SEPARATE, independent, immediate notification.
--
-- Design: reuses the existing meta_lead_ingestions row (already the
-- durable, idempotent, one-row-per-leadgen_id/facebookLeadId record of
-- "this exact lead was genuinely processed for the first time" — see
-- 20260903005457_..._meta_lead_ingestion.sql) rather than introducing a
-- new delivery-tracking table. The immediate email is first attempted
-- synchronously, at most once per row, exactly when the ingestion route
-- observes outcome "processed" (never on
-- "duplicate"/"in_progress_elsewhere"/"failed") — see
-- lib/notifications/new-lead-notification.ts's
-- shouldSendNewLeadNotification for that (independently unit-tested)
-- decision rule, and app/api/zapier/facebook-leads/route.ts +
-- app/api/meta/leadgen-webhook/route.ts for where it's called.
--
-- notification_sent_at / notification_error are diagnostic-only,
-- mirroring the existing error_message column's own role on this same
-- table: they record what happened to the *email*, entirely separate
-- from status/error_message which record what happened to the
-- *ingestion* (Contact/Lead/Touchpoint) itself. A failed email send
-- NEVER rolls back or blocks the ingestion — by the time either column
-- here is written, the lead is already durably PROCESSED.
--
-- notification_attempt_count is what makes a temporary provider/network
-- failure recoverable without ever risking a duplicate email: a genuine
-- resend of the same facebookLeadId (Zapier retry, Vercel network
-- retry, Meta's own webhook redelivery) is already caught upstream by
-- meta_lead_ingestions.leadgen_id's own uniqueness and never re-enters
-- the "processed" branch at all (see shouldSendNewLeadNotification) —
-- this column exists purely so the SAME already-PROCESSED row can be
-- safely retried later, by app/api/cron/follow-up-notifications's own
-- processNewLeadNotificationRetries job, if its first (synchronous)
-- send attempt failed. The claim for each retry attempt is a single
-- atomic compare-and-swap UPDATE keyed on this column's previously-read
-- value (see that job's own comment for the exact mechanism) — the same
-- "atomic conditional UPDATE, no separate lock table" technique this
-- table's own claimForProcessing (lib/meta/repo.ts) already uses for
-- ingestion itself, just expressed via a counter equality check instead
-- of a status transition. Bounded by
-- lib/notifications/new-lead-notification.ts's
-- isNewLeadNotificationRetryEligible so a permanently broken email
-- provider cannot retry forever.
alter table public.meta_lead_ingestions
  add column notification_sent_at timestamptz,
  add column notification_error text,
  add column notification_attempt_count integer not null default 0;

comment on column public.meta_lead_ingestions.notification_sent_at is
  'When the immediate "new lead" email (see lib/notifications/new-lead-notification.ts) '
  'was confirmed sent by the email provider for this ingestion row. Null until sent, '
  'and stays null forever if the row was never eligible (duplicate/failed ingestion), the '
  'send permanently failed after exhausting retries, or a retry is still pending. '
  'Independent of the next-day AUTOMATIC follow-up escalation, which has its own separate '
  'delivery tables and is unaffected by this column.';

comment on column public.meta_lead_ingestions.notification_error is
  'Sanitized, secret-free error message from the most recent immediate "new lead" email '
  'send attempt, if it failed. Diagnostic only — a failure here never blocks or retries '
  'the ingestion itself; the next-day AUTOMATIC follow-up escalation remains the safety '
  'net for a lead whose immediate email never arrived. Cleared back to null on a '
  'subsequent successful send.';

comment on column public.meta_lead_ingestions.notification_attempt_count is
  'How many times the immediate "new lead" email has been attempted for this row (the '
  'initial synchronous attempt plus any cron-driven retries via '
  'app/api/cron/follow-up-notifications processNewLeadNotificationRetries). Starts at 0; '
  'a fresh row that has never had a notification attempt stays at 0 until its first '
  'attempt. Retries stop once this reaches the job''s own MAX_NEW_LEAD_NOTIFICATION_ATTEMPTS '
  '(see isNewLeadNotificationRetryEligible) — bounded so a permanently broken email '
  'provider can never retry forever. Also doubles as the optimistic-concurrency-control '
  'key for each retry attempt''s atomic claim.';

-- No grant changes needed: service_role already holds UPDATE on
-- meta_lead_ingestions (see 20260903005457_..._meta_lead_ingestion.sql
-- — "grant select, insert, update on public.meta_lead_ingestions to
-- service_role"), which already covers these three new columns. The
-- existing authenticated SELECT-only RLS policy on this table already
-- covers them too (row-level, not column-level) — same visibility as
-- the existing status/error_message columns, for the same future-admin-
-- view reason documented there.
