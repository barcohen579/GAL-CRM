# Automatic monthly recurring services & payments — architecture & operations

Server-side scheduler that keeps an active monthly-recurring `Purchase`'s
`Payment` history current automatically — Gal never has to open a
customer every month and click "paid".

**As of this writing, the scheduler is deployed but NOT yet authenticated
in Production** — see [Required manual step](#required-manual-step-set-cron_secret-in-vercel)
below. Until that one step is done, the daily cron request will fail
closed (401) — no payments will be generated, and no financial record
will ever be created without it.

## Architecture

```
Vercel Cron (vercel.json, daily)
  │  GET, header: Authorization: Bearer <CRON_SECRET>
  ▼
GET /api/cron/recurring-billing        app/api/cron/recurring-billing/route.ts
  │  verifyCronAuthHeader()             lib/cron/auth.ts (constant-time compare)
  ▼  only past this point does it touch the database at all
createAdminClient() (service_role)     lib/supabase/admin.ts
  │
  ▼
supabase.rpc("generate_due_recurring_payments")
  │                                     supabase/migrations/
  │                                     ..._recurring_billing_generator.sql
  ├─ for every ACTIVE RECURRING_MONTHLY purchase whose
  │  next_billing_date <= today:
  │    while next_billing_date <= today:
  │      INSERT payment (billing_cycle = that month, paid_at = that
  │        month's 1st, status = PAID, is_auto_generated = true)
  │      ON CONFLICT (purchase_id, billing_cycle) DO NOTHING
  │      UPDATE purchases.next_billing_date += 1 month
  └─ returns one row per payment actually created (for logging only)
```

## Data model (minimum extension of the existing schema)

No new tables. Two nullable columns added to the existing
`purchases`/`payments` tables (migration
`20260903150000_..._recurring_billing_schema.sql`):

- `purchases.next_billing_date` (date, nullable) — first-of-month date
  of the next un-generated cycle. `NULL` = not currently auto-billing.
  `purchases.recurrence` (`ONE_TIME` | `RECURRING_MONTHLY`, pre-existing)
  and `purchases.agreed_price_amount` (pre-existing, reused as "current
  monthly amount") complete the picture — no separate price-history
  table; every generated payment permanently freezes its own amount.
- `payments.billing_cycle` (date, nullable) — first-of-month date this
  payment is FOR. Set on the manually-entered first cycle too, not
  only auto-generated ones.
- `payments.is_auto_generated` (boolean) — true only for job-created rows.

**Idempotency — the actual guarantee, at the database level:**
`unique index payments_purchase_billing_cycle_key on payments
(purchase_id, billing_cycle) where billing_cycle is not null`. The
generator's `INSERT ... ON CONFLICT DO NOTHING` relies entirely on this
— running the job 5 times in a row, or genuinely concurrently, produces
exactly one payment per purchase per month, guaranteed by Postgres
itself, not by the job's own care.

**Catch-up:** a purchase's cycle becomes "due" the moment its month
begins (`next_billing_date <= current_date`) — there is no exact
day-of-month billing anchor (see the schema migration's own comment for
why). If the job hasn't run in weeks, the next run backfills every
missed month in one pass, each with its OWN correct `paid_at` (so
dashboard revenue always lands in the right calendar month, even for a
late catch-up run).

## Correcting a month ("לא שילמה החודש")

An auto-generated payment is *assumed* PAID. If it turns out the
customer didn't actually pay, `markPaymentUnpaid()`
(`app/(app)/payments/actions.ts`) flips that ONE row's `status` to
`FAILED` — never a DELETE, never a rewrite of `amount`/`paid_at`. This
is allowed by the pre-existing `prevent_payment_fact_changes` trigger,
the same mechanism that has always powered a `REFUNDED` correction in
this schema. Effective (PAID-only) revenue queries automatically stop
counting it; the original record stays fully traceable. Recurrence
itself is untouched — next month still bills normally unless separately
stopped.

## Price changes

`updateRecurringPrice()` updates `purchases.agreed_price_amount` only —
every already-generated payment already froze its own amount
permanently, so a price change can never rewrite history. The next
cycle the generator creates simply reads the new value.

## Required manual step: set CRON_SECRET in Vercel

This could not be completed as part of this deployment (no Vercel
CLI/dashboard access in this environment):

1. Generate a long random secret, e.g. `openssl rand -hex 32`.
2. Vercel Dashboard → the GAL-CRM project → Settings → Environment
   Variables → add `CRON_SECRET` (that value) to the **Production**
   environment.
3. Redeploy (or wait for the next deploy) so the function picks it up.
4. Confirm: `GET /api/cron/recurring-billing/health` should return
   `{"ready": true, "checks": {"cronSecretConfigured": true}}`.

Until step 2 is done, Vercel's daily cron request arrives with no (or a
mismatched) `Authorization` header and the route returns 401 — safe
(nothing is generated), but inert.

## Enabling recurrence on the first real customer

Deliberately not done as part of this deployment — see
`/customers/[id]` → an existing ACTIVE service's "הפעלת חיוב חודשי"
button. Pick the monthly amount and the next billing date (if this
month is already paid, pick next month).
