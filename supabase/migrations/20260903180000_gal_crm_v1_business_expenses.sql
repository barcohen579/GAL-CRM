-- GAL CRM V1 — business_expenses (Monthly Business Report, expense side)
--
-- Manually-entered, non-Meta business expenses ("הוצאות עסק") — rent,
-- software, equipment, etc. Meta advertising spend is NEVER inserted
-- here: it already has its own dedicated, automatically-synced table
-- (public.meta_campaign_daily_metrics) and its own well-established
-- attribution semantics (lib/crm/marketing.ts). Keeping the two
-- separate is what makes "סה״כ הוצאות = הוצאת מטא + הוצאות עסק"
-- correct by construction instead of by convention — there is no
-- single "expenses" table an accidental extra INSERT could double-count
-- Meta spend into.
--
-- Design:
--   expense_date date (not created_at!) is the sole determinant of
--     which month's report an expense belongs to — same historical-
--     accuracy convention as payments.paid_at (see that table's own
--     comment) and purchases.start_date: an expense entered in
--     October for a September rent payment must count in September.
--   amount_minor integer, agorot — same money convention as every
--     other financial table in this schema. Never floating point.
--   category is a fixed enum (not free text) so revenue/expense
--     reporting can group reliably without fuzzy string matching —
--     mirrors service_type/touchpoint_channel's existing precedent of
--     app-controlled vocabularies rather than open text fields for
--     anything that needs to be aggregated.
--   created_by uuid, nullable, ON DELETE SET NULL — same shape as
--     touchpoints.created_by/lead_stage_events.changed_by. Present for
--     schema consistency; like those columns, no Server Action in this
--     codebase currently populates it (confirmed: grep for
--     "created_by" across app/ returns nothing) — this is an existing,
--     accepted pattern in this schema, not a gap introduced here.
--
-- Financial-correction philosophy (proportionate to payments, not
-- identical): payments.amount/paid_at/etc. are frozen by a BEFORE
-- UPDATE trigger (prevent_payment_fact_changes) specifically because
-- payments can be AUTOMATICALLY generated (recurring billing) and
-- later need a distinct "assumed vs. actually happened" correction
-- trail (PAID -> FAILED) while preserving the original automated
-- record for audit. A manually-entered expense has no such duality —
-- Gal enters it once, herself; if she made a typo, directly correcting
-- it is the honest fix, not leaving a wrong number "frozen" with a
-- separate correction row bolted on. So: full UPDATE is allowed here
-- (any field, including amount_minor/expense_date), tracked via
-- updated_at for when a correction happened — but, matching payments'
-- strongest guarantee, there is NO DELETE POLICY for any role: expense
-- history can never be silently destroyed through the app, full stop.

create type public.business_expense_category as enum (
  'RENT',
  'SOFTWARE_SUBSCRIPTIONS',
  'EQUIPMENT',
  'MARKETING_OTHER',
  'PROFESSIONAL_SERVICES',
  'MAINTENANCE',
  'OTHER'
);

create table public.business_expenses (
  id uuid primary key default gen_random_uuid(),
  expense_date date not null,
  -- Integer minor units (agorot for ILS). Never floating point.
  amount_minor integer not null check (amount_minor >= 0),
  currency char(3) not null default 'ILS' check (currency ~ '^[A-Z]{3}$'),
  category public.business_expense_category not null,
  description text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.business_expenses is
  'Manually-entered, non-Meta business expenses. expense_date (not '
  'created_at) determines which monthly report an expense belongs to. '
  'Meta ad spend is never recorded here — it has its own dedicated '
  'meta_campaign_daily_metrics table, so "total expenses" is always '
  'Meta spend + this table, never double-counted. Full UPDATE is '
  'allowed (manually-entered, single-author data — a direct correction '
  'is the honest fix for a typo, unlike payments'' automated-then-'
  'corrected duality); there is no DELETE policy for any role, so '
  'expense history can never be silently destroyed through the app.';

create index business_expenses_expense_date_idx on public.business_expenses (expense_date);
create index business_expenses_category_idx on public.business_expenses (category);

create trigger set_updated_at
  before update on public.business_expenses
  for each row execute function public.set_updated_at();

-- ============================================================
-- Row Level Security — full CRUD except DELETE for authorized active
-- CRM users, same shape as payments (see
-- 20260902083853_gal_crm_v1_authorization_rls.sql for that precedent
-- and its own reasoning).
-- ============================================================

alter table public.business_expenses enable row level security;

create policy business_expenses_crm_select
  on public.business_expenses for select
  using (public.is_crm_user());

create policy business_expenses_crm_insert
  on public.business_expenses for insert
  with check (public.is_crm_user());

create policy business_expenses_crm_update
  on public.business_expenses for update
  using (public.is_crm_user())
  with check (public.is_crm_user());

-- Deliberately no business_expenses_crm_delete policy.

grant select, insert, update on public.business_expenses to authenticated;
