-- GAL CRM V1 — automatic monthly recurring services & payments: schema
--
-- Adds the minimum normalized fields needed to represent an ongoing
-- monthly-recurring service on the EXISTING purchases/payments tables —
-- deliberately NOT a new "subscriptions" table. purchases already has
-- everything a recurring deal needs (customer_id, service_type,
-- agreed_price_amount, recurrence, status, start_date); this migration
-- only adds what's missing: a deterministic "when is the next cycle
-- due" pointer, and a "which calendar month does this payment
-- represent" identity on payments strong enough to guarantee, at the
-- DATABASE level, that the same purchase can never get two payments
-- for the same month — no matter how many times a scheduled job runs,
-- concurrently or repeatedly.
--
-- ============================================================
-- DESIGN
-- ============================================================
--
-- purchases.next_billing_date (date, nullable):
--   The first-of-month date of the NEXT cycle still owed for this
--   purchase. NULL means "not currently auto-billing" — either a
--   ONE_TIME purchase, or a RECURRING_MONTHLY purchase whose billing
--   was stopped (see "stopping" below). Only ever meaningful when
--   recurrence = 'RECURRING_MONTHLY' AND status = 'ACTIVE' (enforced
--   by a CHECK constraint below for the recurrence half; status is a
--   simple AND-condition the generator query applies itself, not
--   something a CHECK can express against a mutable sibling column
--   without a trigger, and isn't worth one here — a CANCELLED
--   purchase with a stale next_billing_date is inert, never queried
--   by the generator, and is defensively cleared to NULL by the
--   "stop" action anyway).
--
--   Deliberately NOT an exact day-of-month anchor (e.g. "bills on the
--   3rd of every month, clamped for short months"). This CRM is
--   operational bookkeeping, not a payment processor — what matters
--   for Gal's revenue picture is "one payment per active month", not
--   which day of the month it lands on. A cycle becomes due as soon as
--   its month has begun: next_billing_date <= current_date. This also
--   directly avoids depending on exact-time/day scheduler precision —
--   see the scheduler migration for the daily-catch-up job that reads
--   this column.
--
-- purchases.agreed_price_amount is REUSED as the current recurring
--   amount — not duplicated into a separate column. A price change
--   (see the actions migration) simply updates it going forward; every
--   already-generated payments row already froze its own amount
--   permanently (payments.amount is immutable — see
--   prevent_payment_fact_changes), so past cycles are never rewritten
--   by a later price change. No separate price-history table: the
--   payments ledger itself IS the price history, exactly as accurate
--   as what was actually charged each month.
--
-- payments.billing_cycle (date, nullable):
--   The first-of-month date this payment is FOR — set on every
--   payment that belongs to a recurring purchase's monthly cycle,
--   whether it was entered manually (the first cycle, typically) or
--   generated automatically by the scheduled job. NULL for payments
--   that aren't tied to a monthly cycle at all (one-time purchases,
--   ad-hoc extra payments). This is the cycle identity the unique
--   index below enforces uniqueness on.
--
-- payments.is_auto_generated (boolean, not null default false):
--   True only for rows created by the scheduled job
--   (generate_due_recurring_payments — see the functions migration).
--   Never set by any user-facing action. Purely a display/audit
--   marker ("אוטומטי" badge) — carries no other behavior.
--
-- payments.updated_at (timestamptz):
--   Added for audit visibility: prevent_payment_fact_changes already
--   allows status/notes to change after creation (that's how a
--   REFUNDED correction has always worked in this schema) — this
--   column now also lets Gal (and anyone auditing later) see WHEN a
--   payment's status was last changed, e.g. when an auto-generated
--   "assumed PAID" payment is later corrected to FAILED because the
--   customer didn't actually pay that month (see the actions
--   migration's markPaymentUnpaid). created_at (never touched by that
--   trigger) remains the original, permanent creation timestamp.
--
-- ============================================================
-- IDEMPOTENCY — the core guarantee (requirement: DB-level, not just
-- application code)
-- ============================================================
--
-- unique index payments_purchase_billing_cycle_key on
-- (purchase_id, billing_cycle) WHERE billing_cycle IS NOT NULL:
--   At most one payment per purchase per calendar-month cycle, full
--   stop, enforced by Postgres itself. The scheduled job's INSERT uses
--   ON CONFLICT (purchase_id, billing_cycle) DO NOTHING — if it runs
--   5 times for the same purchase on the same day (or is genuinely
--   concurrent), only the first INSERT ever succeeds; every other
--   attempt is a harmless no-op, guaranteed by this index, not by the
--   job's own care. This is also exactly what makes "the first payment
--   is recorded immediately at signup, don't generate it twice" safe:
--   a manually-recorded first-cycle payment occupies that
--   (purchase_id, billing_cycle) slot just as validly as an
--   auto-generated one would, so the job's later attempt for that same
--   month simply conflicts and moves on.
--
-- ============================================================
-- Migration safety over REAL production data (explicit V1 requirement)
-- ============================================================
--
-- Every column added below is nullable (or has a safe default) and
-- this migration performs NO backfill/UPDATE of any kind — every
-- existing purchases row keeps recurrence = 'ONE_TIME' (its existing
-- value; already the default, never touched by this migration; no
-- existing row is retroactively turned into a recurring service) and
-- next_billing_date = NULL. No existing payments row is touched:
-- billing_cycle and is_auto_generated default to NULL/false for all of
-- them. Recurrence is enabled per-purchase, explicitly, only through
-- the UI action added in the follow-up migration — never automatically
-- by this one.

alter table public.purchases
  add column next_billing_date date;

alter table public.purchases
  add constraint purchases_next_billing_date_requires_recurring
  check (next_billing_date is null or recurrence = 'RECURRING_MONTHLY');

alter table public.purchases
  add constraint purchases_next_billing_date_is_month_start
  check (next_billing_date is null or next_billing_date = date_trunc('month', next_billing_date)::date);

comment on column public.purchases.next_billing_date is
  'First-of-month date of the next un-generated recurring cycle. NULL '
  '= not currently auto-billing (ONE_TIME, or RECURRING_MONTHLY but '
  'stopped). Only meaningful with recurrence = RECURRING_MONTHLY and '
  'status = ACTIVE. Never set by this migration for any existing row.';

create index purchases_next_billing_date_idx
  on public.purchases (next_billing_date)
  where next_billing_date is not null;

alter table public.payments
  add column billing_cycle date,
  add column is_auto_generated boolean not null default false,
  add column updated_at timestamptz not null default now();

alter table public.payments
  add constraint payments_billing_cycle_is_month_start
  check (billing_cycle is null or billing_cycle = date_trunc('month', billing_cycle)::date);

comment on column public.payments.billing_cycle is
  'First-of-month date this payment represents, for a recurring '
  'purchase''s monthly cycle only (manually-entered first cycle, or '
  'any auto-generated one). NULL for non-cycle payments (one-time '
  'purchases, ad-hoc extras). Paired with purchase_id in the unique '
  'index below — the sole DB-level idempotency guarantee for '
  'automatic monthly generation.';

comment on column public.payments.is_auto_generated is
  'True only for rows created by generate_due_recurring_payments() — '
  'never set by any user-facing action. Display/audit marker only.';

comment on column public.payments.updated_at is
  'Set on every UPDATE (a status/notes correction — the only columns '
  'prevent_payment_fact_changes allows to change). created_at remains '
  'the original, permanent creation timestamp regardless.';

create unique index payments_purchase_billing_cycle_key
  on public.payments (purchase_id, billing_cycle)
  where billing_cycle is not null;

create index payments_billing_cycle_idx
  on public.payments (billing_cycle)
  where billing_cycle is not null;

create trigger set_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();
