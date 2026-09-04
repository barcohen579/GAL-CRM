-- GAL CRM V1 — recurring business expenses ("הוצאה חודשית קבועה")
--
-- Extends the existing business_expenses architecture (see
-- 20260903180000_..._business_expenses.sql) to represent an ongoing
-- monthly expense (rent, software, insurance, ...) that Gal enters
-- ONCE and which the CRM then keeps current automatically — the exact
-- same shape of problem the recurring CUSTOMER billing feature already
-- solved (see 20260903150000_..._recurring_billing_schema.sql and
-- 20260903150200_..._recurring_billing_generator.sql), reused
-- CONCEPTUALLY here (same next-occurrence-pointer + frozen-occurrence-
-- ledger + idempotent-generator shape) but on ENTIRELY SEPARATE tables
-- — never touching purchases/payments in any way. Business expenses
-- and customer billing must stay fully independent so neither can ever
-- leak into or be confused with the other's ledger.
--
-- ============================================================
-- DESIGN — why two tables, not one
-- ============================================================
--
-- business_expenses (existing table) already IS the ledger: one row
-- per real expense event on one real date, amount frozen at the moment
-- it's recorded. That's exactly right for a ONE_TIME expense and
-- exactly right for each individual MONTH of a recurring one — but a
-- recurring expense also needs a place to hold the "current" ongoing
-- definition (amount that applies going forward, active/stopped state,
-- which month is next due) that is NOT itself a dated ledger entry.
-- purchases/payments already had this exact two-table split for
-- customer billing (purchases = the deal, payments = the ledger); this
-- migration gives business expenses the same split:
--
--   public.business_recurring_expenses — the "deal": description,
--     category, CURRENT amount_minor (reused for every future
--     occurrence, exactly like purchases.agreed_price_amount),
--     status (ACTIVE/STOPPED), next_occurrence_date. One row per
--     ongoing recurring expense, its identity never changes.
--
--   public.business_expenses (extended, not replaced) — every
--     individual month's occurrence is still just a normal expense
--     row here, exactly like before, now optionally tagged back to
--     the recurring definition it came from via recurring_expense_id
--     + occurrence_month (mirrors payments.purchase_id +
--     payments.billing_cycle exactly). A one-time expense simply
--     never sets these two columns — NULL, unchanged from today.
--
-- This is why lib/crm/marketing.ts's buildMonthlyMetrics needs ZERO
-- changes: it already sums ALL business_expenses rows by expense_date
-- for the "other business expenses" figure, and an auto-generated
-- recurring occurrence is, from that query's point of view, just
-- another business_expenses row with a real expense_date — the
-- monthly/historical report picks it up automatically, exactly as the
-- task requires ("do not create a second date-filter system").
--
-- ============================================================
-- IDEMPOTENCY — the actual guarantee (same mechanism as
-- payments_purchase_billing_cycle_key)
-- ============================================================
--
-- unique index business_expenses_recurring_occurrence_key on
-- (recurring_expense_id, occurrence_month) WHERE both NOT NULL: at
-- most one expense row per recurring definition per calendar month,
-- enforced by Postgres itself. The generator's INSERT uses
-- ON CONFLICT (...) DO NOTHING against this exact index — running it
-- any number of times, or concurrently, produces exactly one row per
-- recurring expense per month, guaranteed by the database, not by the
-- generator function's own care.
--
-- ============================================================
-- Price changes / stopping — same guarantee as recurring billing
-- ============================================================
--
-- business_recurring_expenses.amount_minor is the CURRENT amount,
-- reused for every future generated occurrence. Changing it (see
-- updateRecurringExpenseAmount in app/(app)/dashboard/actions.ts)
-- updates ONLY this row — every already-generated business_expenses
-- occurrence row already has its own amount_minor frozen at insert
-- time (a plain column value, never a foreign lookup), so a price
-- change can never rewrite a historical month. Stopping
-- (status = 'STOPPED', next_occurrence_date = null) blocks all FUTURE
-- generation while every already-generated occurrence row is untouched
-- — exactly stopRecurringBilling's own behavior for purchases.
--
-- ============================================================
-- Migration safety over REAL production data
-- ============================================================
--
-- business_expenses gets three new NULLABLE columns with safe
-- defaults and NO backfill/UPDATE of any existing row: every row that
-- exists today keeps recurring_expense_id = NULL, occurrence_month =
-- NULL, is_auto_generated = false (its existing implicit state) — no
-- existing manually-entered expense is retroactively reinterpreted as
-- part of a recurring series. business_recurring_expenses is a brand
-- new, empty table. Nothing is enabled automatically; a recurring
-- expense only ever comes into existence through the explicit
-- create_recurring_business_expense() RPC below, called only from the
-- "הוצאה חודשית קבועה" UI action.

-- ============================================================
-- business_recurring_expenses — the "deal"
-- ============================================================

create type public.business_recurring_expense_status as enum (
  'ACTIVE',
  'STOPPED'
);

create table public.business_recurring_expenses (
  id uuid primary key default gen_random_uuid(),
  description text,
  category public.business_expense_category not null,
  -- Integer minor units (agorot for ILS). Never floating point. The
  -- CURRENT monthly amount — reused for every future occurrence,
  -- exactly like purchases.agreed_price_amount. Changing it never
  -- rewrites an already-generated business_expenses row.
  amount_minor integer not null check (amount_minor >= 0),
  currency char(3) not null default 'ILS' check (currency ~ '^[A-Z]{3}$'),
  start_date date not null,
  status public.business_recurring_expense_status not null default 'ACTIVE',
  -- First-of-month date of the next un-generated occurrence. NULL =
  -- not currently auto-generating (only ever true once STOPPED — an
  -- ACTIVE recurring expense always has one, unlike purchases where
  -- ONE_TIME purchases also leave it NULL; there is no "one-time" case
  -- in this table at all, see the design note above).
  next_occurrence_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_recurring_expenses_next_occurrence_requires_active
    check (next_occurrence_date is null or status = 'ACTIVE'),
  constraint business_recurring_expenses_next_occurrence_is_month_start
    check (next_occurrence_date is null or next_occurrence_date = date_trunc('month', next_occurrence_date)::date)
);

comment on table public.business_recurring_expenses is
  'The ongoing "deal" for a recurring monthly business expense (rent, '
  'software, insurance, ...) — current amount, active/stopped state, '
  'next-occurrence pointer. Each individual month''s actual expense is '
  'a separate row in business_expenses (recurring_expense_id + '
  'occurrence_month), exactly mirroring purchases/payments. Never '
  'referenced by, or referencing, purchases/payments/customers in any '
  'way — business expenses stay fully independent of customer billing.';

create index business_recurring_expenses_status_idx
  on public.business_recurring_expenses (status);
create index business_recurring_expenses_next_occurrence_date_idx
  on public.business_recurring_expenses (next_occurrence_date)
  where next_occurrence_date is not null;

create trigger set_updated_at
  before update on public.business_recurring_expenses
  for each row execute function public.set_updated_at();

alter table public.business_recurring_expenses enable row level security;

create policy business_recurring_expenses_crm_select
  on public.business_recurring_expenses for select
  using (public.is_crm_user());

create policy business_recurring_expenses_crm_insert
  on public.business_recurring_expenses for insert
  with check (public.is_crm_user());

create policy business_recurring_expenses_crm_update
  on public.business_recurring_expenses for update
  using (public.is_crm_user())
  with check (public.is_crm_user());

-- Deliberately no DELETE policy — same guarantee as business_expenses
-- and purchases: a recurring expense is stopped, never deleted, so its
-- generated history always stays explainable.

grant select, insert, update on public.business_recurring_expenses to authenticated;

-- ============================================================
-- business_expenses — extend the existing ledger table
-- ============================================================

alter table public.business_expenses
  add column recurring_expense_id uuid references public.business_recurring_expenses(id) on delete restrict,
  add column occurrence_month date,
  add column is_auto_generated boolean not null default false;

alter table public.business_expenses
  add constraint business_expenses_occurrence_month_is_month_start
  check (occurrence_month is null or occurrence_month = date_trunc('month', occurrence_month)::date);

alter table public.business_expenses
  add constraint business_expenses_occurrence_month_requires_recurring_link
  check (
    (recurring_expense_id is null and occurrence_month is null)
    or (recurring_expense_id is not null and occurrence_month is not null)
  );

comment on column public.business_expenses.recurring_expense_id is
  'NULL for a genuinely one-time expense. Set for every occurrence of '
  'a recurring expense (the manually-entered first month AND any '
  'auto-generated later one) — mirrors payments.purchase_id.';
comment on column public.business_expenses.occurrence_month is
  'First-of-month date this row represents, for a recurring expense''s '
  'monthly cycle only. Mirrors payments.billing_cycle exactly, '
  'including being the sole DB-level idempotency key below.';
comment on column public.business_expenses.is_auto_generated is
  'True only for rows created by generate_due_recurring_business_expenses() '
  '— never set by any user-facing action. Display/audit marker only, '
  'mirrors payments.is_auto_generated.';

create unique index business_expenses_recurring_occurrence_key
  on public.business_expenses (recurring_expense_id, occurrence_month)
  where recurring_expense_id is not null;

create index business_expenses_recurring_expense_id_idx
  on public.business_expenses (recurring_expense_id)
  where recurring_expense_id is not null;

-- ============================================================
-- create_recurring_business_expense — atomic "add a recurring expense"
--
-- Mirrors create_customer_directly's own reasoning for needing a
-- single SQL function rather than two sequential client requests: this
-- creates the business_recurring_expenses "deal" AND its first
-- occurrence row together — if the second insert failed after the
-- first succeeded via separate requests, Gal would be left with a
-- recurring expense with no first month recorded. One function body is
-- one Postgres transaction: both rows commit together or neither does.
--
-- SECURITY INVOKER (the default, stated explicitly): runs entirely as
-- the calling authenticated user, subject to the exact same RLS
-- policies as if both statements had been issued directly — adds no
-- privilege. Both target tables already have full INSERT policy +
-- table grant coverage for authenticated (added above / pre-existing),
-- so no elevated role or extra grant is needed here.
-- ============================================================

create or replace function public.create_recurring_business_expense(
  p_description text,
  p_category public.business_expense_category,
  p_amount_minor integer,
  p_start_date date,
  p_currency char(3) default 'ILS'
)
returns table (
  recurring_expense_id uuid,
  expense_id uuid
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_recurring_id uuid;
  v_expense_id uuid;
  v_start_month date;
begin
  if p_amount_minor is null or p_amount_minor < 0 then
    raise exception 'A valid amount is required';
  end if;
  if p_start_date is null then
    raise exception 'A start date is required';
  end if;

  v_start_month := date_trunc('month', p_start_date)::date;

  insert into public.business_recurring_expenses (
    description, category, amount_minor, currency, start_date, status, next_occurrence_date
  ) values (
    p_description, p_category, p_amount_minor, coalesce(p_currency, 'ILS'), p_start_date, 'ACTIVE',
    (v_start_month + interval '1 month')::date
  ) returning id into v_recurring_id;

  -- The first month's occurrence is recorded immediately (Gal is
  -- entering this because the expense is happening now) — exactly the
  -- same "first cycle recorded at signup, generator picks up from the
  -- month after" shape create_customer_directly already uses for a
  -- purchase's optional first payment.
  insert into public.business_expenses (
    expense_date, amount_minor, currency, category, description,
    recurring_expense_id, occurrence_month, is_auto_generated
  ) values (
    p_start_date, p_amount_minor, coalesce(p_currency, 'ILS'), p_category, p_description,
    v_recurring_id, v_start_month, false
  ) returning id into v_expense_id;

  recurring_expense_id := v_recurring_id;
  expense_id := v_expense_id;
  return next;
end;
$$;

comment on function public.create_recurring_business_expense(text, public.business_expense_category, integer, date, char(3)) is
  'Atomically creates a recurring business expense definition AND its '
  'first month''s occurrence row. SECURITY INVOKER — adds no privilege '
  'beyond what RLS already grants authenticated.';

revoke all on function public.create_recurring_business_expense(text, public.business_expense_category, integer, date, char(3)) from public;
grant execute on function public.create_recurring_business_expense(text, public.business_expense_category, integer, date, char(3)) to authenticated;

-- ============================================================
-- generate_due_recurring_business_expenses — the scheduled job body
--
-- Mirrors generate_due_recurring_payments() exactly (see that
-- function's own extensive comments in
-- 20260903150200_..._recurring_billing_generator.sql for the full
-- reasoning behind every choice below — repeated only briefly here):
--
--   - Called once a day by app/api/cron/recurring-business-expenses/
--     route.ts via the service_role admin client, authenticated by the
--     SAME CRON_SECRET, never reachable by a normal CRM session or the
--     browser (EXECUTE revoked from public/authenticated below).
--   - For each ACTIVE recurring expense whose next_occurrence_date is
--     due, generates every missed month in one pass (catch-up), each
--     with its own correct expense_date — never all stamped "today".
--   - INSERT ... ON CONFLICT (recurring_expense_id, occurrence_month)
--     DO NOTHING is the actual, database-enforced, idempotency
--     guarantee — safe under any number of repeated or concurrent runs.
--   - next_occurrence_date advances unconditionally after each
--     attempted cycle, whether the insert created a new row or hit the
--     conflict (e.g. Gal already recorded that month manually) — so a
--     manually-pre-recorded month is never duplicated by this job,
--     exactly like the manually-recorded-first-payment case for
--     customer billing.
--   - Each cycle's work happens inside its own nested BEGIN/EXCEPTION
--     block (implicit savepoint): a failure generating one cycle for
--     one recurring expense never blocks any other cycle or any other
--     recurring expense in the same run.
--
-- Output columns prefixed "out_" for the exact same reason documented
-- on generate_due_recurring_payments(): avoiding an ambiguous-column
-- (42702) footgun against this function's own table column names.
-- ============================================================

create or replace function public.generate_due_recurring_business_expenses()
returns table (
  out_recurring_expense_id uuid,
  out_expense_id uuid,
  out_occurrence_month date,
  out_amount_minor integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_re record;
  v_cycle date;
  v_expense_id uuid;
begin
  for v_re in
    select re.id, re.category, re.amount_minor, re.currency, re.description, re.next_occurrence_date
    from public.business_recurring_expenses re
    where re.status = 'ACTIVE'
      and re.next_occurrence_date is not null
      and re.next_occurrence_date <= current_date
    order by re.id
    for update of re
  loop
    v_cycle := v_re.next_occurrence_date;

    while v_cycle <= current_date loop
      begin
        v_expense_id := null;

        insert into public.business_expenses (
          expense_date, amount_minor, currency, category, description,
          recurring_expense_id, occurrence_month, is_auto_generated
        )
        values (
          v_cycle, v_re.amount_minor, v_re.currency, v_re.category, v_re.description,
          v_re.id, v_cycle, true
        )
        on conflict (recurring_expense_id, occurrence_month) where recurring_expense_id is not null
        do nothing
        returning id into v_expense_id;

        update public.business_recurring_expenses
        set next_occurrence_date = (date_trunc('month', v_cycle) + interval '1 month')::date
        where id = v_re.id;

        if v_expense_id is not null then
          out_recurring_expense_id := v_re.id;
          out_expense_id := v_expense_id;
          out_occurrence_month := v_cycle;
          out_amount_minor := v_re.amount_minor;
          return next;
        end if;
      exception when others then
        raise warning 'generate_due_recurring_business_expenses: failed for recurring_expense % cycle %: %',
          v_re.id, v_cycle, sqlerrm;
        exit;
      end;

      v_cycle := (date_trunc('month', v_cycle) + interval '1 month')::date;
    end loop;
  end loop;

  return;
end;
$$;

comment on function public.generate_due_recurring_business_expenses() is
  'Scheduled job body: generates every due monthly occurrence for '
  'every ACTIVE recurring business expense, backfilling any missed '
  'months, exactly once per (recurring_expense_id, occurrence_month) '
  'no matter how many times or how concurrently this is called '
  '(enforced by business_expenses_recurring_occurrence_key, not by '
  'this function''s own logic). Called only by service_role via '
  'app/api/cron/recurring-business-expenses/route.ts. Never touches '
  'purchases, payments, or any customer/lead/referral table.';

revoke all on function public.generate_due_recurring_business_expenses() from public;
revoke all on function public.generate_due_recurring_business_expenses() from authenticated;
grant execute on function public.generate_due_recurring_business_expenses() to service_role;

-- service_role grants — this project has automatic-RLS-with-default-
-- grants disabled (see 20260903005457_..._meta_lead_ingestion.sql for
-- the established precedent), so service_role gets no privileges here
-- until explicitly granted. Exactly what the generator needs, no more
-- — same shape as the payments/purchases service_role grants in
-- 20260903150200_..._recurring_billing_generator.sql:
--
--   business_recurring_expenses -> SELECT (find due ones), UPDATE
--     (advance next_occurrence_date). No INSERT/DELETE.
--   business_expenses -> SELECT, INSERT (create the occurrence row;
--     SELECT is additionally required for the RETURNING clause). No
--     UPDATE/DELETE — this job never touches an existing row.

grant select, update on public.business_recurring_expenses to service_role;
grant select, insert on public.business_expenses to service_role;

-- ============================================================
-- New expense categories — extends the existing vocabulary with what
-- a fitness-studio business realistically needs, per explicit request.
-- Each ADD VALUE is its own statement (required) and IF NOT EXISTS-
-- guarded for safe re-application. None of these new labels are
-- referenced anywhere else in this same migration (no CHECK
-- constraint, no seed INSERT uses them), so there is no "unsafe use of
-- new enum value in the same transaction it was added in" risk.
-- ============================================================

alter type public.business_expense_category add value if not exists 'UTILITIES';
alter type public.business_expense_category add value if not exists 'CONTENT_PRODUCTION';
alter type public.business_expense_category add value if not exists 'INSURANCE';
alter type public.business_expense_category add value if not exists 'TRAINING_EDUCATION';
alter type public.business_expense_category add value if not exists 'OFFICE_SUPPLIES';
