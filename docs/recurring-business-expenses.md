# Recurring business expenses — architecture & operations

Extends the existing `business_expenses` ledger ("הוצאות עסק") so a
monthly expense (rent, software, insurance, ...) can be entered once
and stay current automatically — the exact same shape of feature as
[recurring customer billing](./recurring-billing.md), reused
**conceptually** here on **entirely separate tables**. Never touches
`purchases`/`payments`, and Meta spend never enters `business_expenses`
— it stays exclusively in `meta_campaign_daily_metrics`.

## Architecture

```
Vercel Cron (vercel.json, daily, 10 min after recurring-billing)
  │  GET, header: Authorization: Bearer <CRON_SECRET>  (same secret)
  ▼
GET /api/cron/recurring-business-expenses   app/api/cron/recurring-business-expenses/route.ts
  │  verifyCronAuthHeader()                  lib/cron/auth.ts
  ▼  only past this point does it touch the database at all
createAdminClient() (service_role)           lib/supabase/admin.ts
  │
  ▼
supabase.rpc("generate_due_recurring_business_expenses")
  │                                          supabase/migrations/
  │                                          20260904090000_..._recurring_business_expenses.sql
  ├─ for every ACTIVE business_recurring_expenses row whose
  │  next_occurrence_date <= today:
  │    while next_occurrence_date <= today:
  │      INSERT business_expenses (occurrence_month = that month,
  │        expense_date = that month's 1st, is_auto_generated = true)
  │      ON CONFLICT (recurring_expense_id, occurrence_month) DO NOTHING
  │      UPDATE business_recurring_expenses.next_occurrence_date += 1 month
  └─ returns one row per occurrence actually created (logging only)
```

## Data model

Two tables — mirrors `purchases`/`payments` in shape, not by reuse:

- **`business_recurring_expenses`** (new) — the "deal": `description`,
  `category`, current `amount_minor` (reused for every future
  occurrence — a price change here never rewrites history),
  `status` (`ACTIVE`/`STOPPED`), `next_occurrence_date`.
- **`business_expenses`** (existing, extended) — every individual
  month's occurrence is still just a normal row here. Three new
  nullable columns: `recurring_expense_id`, `occurrence_month`
  (mirrors `payments.billing_cycle`), `is_auto_generated`. A one-time
  expense simply never sets them — unchanged from before this feature.

**Idempotency:** `unique index business_expenses_recurring_occurrence_key
on business_expenses (recurring_expense_id, occurrence_month) where
recurring_expense_id is not null` — the same database-level guarantee
`payments_purchase_billing_cycle_key` gives customer billing.

**Why the Monthly Business Report needed zero changes:**
`buildMonthlyMetrics` (`lib/crm/marketing.ts`) already sums every
`business_expenses` row by `expense_date` for "other business
expenses" — an auto-generated occurrence is, from that query's point
of view, just another row with a real date.

## Adding a recurring expense

`create_recurring_business_expense(description, category, amount_minor,
start_date)` (SQL function, `SECURITY INVOKER`) atomically creates the
recurring definition **and** its first month's occurrence in one
transaction — same reasoning as `create_customer_directly`. Called from
`addExpense()` (`app/(app)/dashboard/actions.ts`) when the "הוספת
הוצאה" dialog's "סוג" is set to "חודשית קבועה".

## Price changes / stopping

- `updateRecurringExpenseAmount()` updates
  `business_recurring_expenses.amount_minor` only — every
  already-generated occurrence keeps its own frozen amount.
- `stopRecurringExpense()` sets `status = 'STOPPED'`,
  `next_occurrence_date = null` — blocks all future generation,
  previous occurrences untouched. Both mirror `updateRecurringPrice()`/
  `stopRecurringBilling()` in `app/(app)/customers/actions.ts` exactly.

## Testing

`supabase/tests/recurring_business_expenses.test.sql` — a self-
contained `BEGIN`/`ROLLBACK` regression script (same style as
`recurring_billing.test.sql`), covering one-time isolation, catch-up
backfill, idempotency (including a direct unique-index violation
check), price-change history preservation, stopping, and confirming
zero effect on Meta spend or customer billing. Run with
`npm run db:test:recurring-business-expenses`.

## Required manual step: CRON_SECRET

Shares the exact same `CRON_SECRET` as `/api/cron/recurring-billing` —
no separate secret or health endpoint needed. See
[recurring-billing.md's own section](./recurring-billing.md#required-manual-step-set-cron_secret-in-vercel)
for the setup steps; once that's configured, both cron jobs are live.
