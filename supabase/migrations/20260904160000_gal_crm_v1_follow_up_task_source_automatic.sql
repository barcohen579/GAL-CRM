-- Adds the AUTOMATIC value to task_source, for the Automatic Lead
-- Follow-Up Escalation Loop (see the next migration,
-- 20260904161000_..._automatic_lead_followup_escalation.sql, for the
-- actual feature). Deliberately its OWN migration file, with NO other
-- DDL/DML alongside it: Postgres does not allow a new enum label to be
-- used (in an INSERT/comparison) inside the same transaction that added
-- it via ALTER TYPE ... ADD VALUE — each `supabase db query`/migration
-- file runs as one transaction, so the value must be committed in a
-- prior, separate transaction before anything can reference 'AUTOMATIC'.
-- This mirrors the two-step ordering already required for any Postgres
-- enum addition; no other table/behavior is touched here.

alter type public.task_source add value 'AUTOMATIC';

comment on type public.task_source is
  'MANUAL: created by Gal via the UI. AUTOMATIC: created by the '
  'create_automatic_followup_for_new_lead() trigger the moment a new '
  'lead is created (any source), and driven by the repeating daily '
  'escalation cron path (see lib/notifications/reminder-logic.ts''s own '
  'isAutomaticEscalationEligible) rather than the one-shot individual '
  'reminder. AI_SUGGESTED is reserved, unused today.';
