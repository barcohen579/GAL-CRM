-- GAL CRM V1 — core schema
--
-- Scope (deliberately excluded from this migration, per V1 plan):
--   - Meta Ads / campaign / daily-metric tables
--   - Notification-provider / reminder-delivery tables
--   - AI SuggestedMessage table
--   - Any RLS policies, and the is_crm_user() helper function that would
--     back them. RLS is enabled below on every table with NO policies —
--     this migration is structure only. Policies are deferred to a
--     separate follow-up migration, written once the first real Supabase
--     Auth user exists (see review notes for why this ordering is safer).
--   - No data is seeded (no Gal, no Bar, no emails/phones/personal info)
--
-- Design notes:
--   - contacts is the canonical person identity; leads and customers both
--     point back to it so the same human is never duplicated.
--   - follow_up_tasks is independent of lead.stage (a lead can be
--     INTERESTED while having zero, one, or many open follow-ups).
--   - touchpoints hold attribution history separately from leads so a lead
--     can have zero touchpoints (no fabricated attribution) or many, with
--     at most one marked primary (enforced by a partial unique index).
--   - Money is stored as integer minor units (agorot for ILS), never float.
--   - payments is an append-only ledger: rows are never deleted; a refund
--     is recorded by updating status, preserving history.

-- ============================================================
-- Extensions
-- ============================================================

create extension if not exists pgcrypto with schema public;

-- ============================================================
-- Enum types
-- ============================================================

create type public.lead_stage as enum (
  'NEW',
  'CONTACTED',
  'INTERESTED',
  'TRIAL_BOOKED',
  'TRIAL_COMPLETED',
  'WON',
  'LOST'
);

create type public.lead_lost_reason as enum (
  'PRICE',
  'TIMING',
  'NO_RESPONSE',
  'CHOSE_COMPETITOR',
  'NOT_INTERESTED',
  'OTHER'
);

-- Shared by leads.interested_service and purchases.service_type so the
-- two never drift apart into separate vocabularies.
create type public.service_type as enum (
  'GROUP_TRAINING',
  'PERSONAL_TRAINING',
  'PARTNER_TRAINING',
  'NUTRITION_COACHING',
  'ONLINE_COACHING',
  'MAMA_RESET',
  'TRIAL_GROUP',
  'TRIAL_PERSONAL',
  'OTHER'
);

create type public.touchpoint_channel as enum (
  'META_AD',
  'INSTAGRAM_ORGANIC',
  'INSTAGRAM_DM',
  'INSTAGRAM_COMMENT',
  'REFERRAL',
  'WORD_OF_MOUTH',
  'WALK_IN',
  'WEBSITE',
  'OTHER',
  'UNKNOWN'
);

create type public.attribution_certainty as enum (
  'CONFIRMED',
  'BROAD',
  'UNKNOWN'
);

create type public.task_status as enum (
  'PENDING',
  'COMPLETED',
  'CANCELLED'
);

create type public.task_source as enum (
  'MANUAL',
  'AI_SUGGESTED'
);

create type public.customer_status as enum (
  'ACTIVE',
  'INACTIVE'
);

create type public.purchase_recurrence as enum (
  'ONE_TIME',
  'RECURRING_MONTHLY'
);

create type public.purchase_status as enum (
  'ACTIVE',
  'COMPLETED',
  'CANCELLED'
);

create type public.payment_method as enum (
  'CASH',
  'CARD',
  'BIT',
  'BANK_TRANSFER',
  'OTHER'
);

create type public.payment_status as enum (
  'PAID',
  'REFUNDED',
  'FAILED'
);

-- ============================================================
-- app_users
-- Minimal internal CRM operator identity. V1 will eventually have Gal
-- as the primary user. No personal data is seeded by this migration.
--
-- auth_user_id links this row to a real Supabase Auth identity
-- (auth.users). It is required (NOT NULL) rather than nullable: an
-- app_users row IS the authorization grant for a specific real
-- authenticated person, and requiring the link at creation time avoids
-- ever having an ambiguous "unlinked" row for RLS policies to reason
-- about. The natural bootstrap order is: a person signs up via Supabase
-- Auth first (creating their auth.users row), then a trusted operator
-- explicitly grants them CRM access by inserting the matching app_users
-- row (via service_role / direct SQL — this first grant cannot happen
-- through the app itself, which is expected for bootstrapping any
-- system's first admin).
--
-- ON DELETE CASCADE on auth_user_id: deleting a person's Supabase Auth
-- account is treated as the way to fully revoke their CRM access, so
-- their app_users row is removed with it. Every other table that
-- references app_users.id (assigned_to / changed_by / created_by) does
-- so with ON DELETE SET NULL, so this never deletes CRM business data —
-- only attribution metadata is cleared.
--
-- is_active supports temporarily suspending CRM access without deleting
-- the underlying Supabase Auth account or losing this row's id (which
-- other tables' created_by/assigned_to fields may still point to).
-- ============================================================

create table public.app_users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  full_name text not null check (length(trim(full_name)) > 0),
  email text unique,
  phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.app_users is
  'Minimal internal CRM user identity, one row per authorized person, linked '
  '1:1 to a Supabase Auth identity via auth_user_id. No personal data seeded '
  'in this migration. RLS policies granting access based on this table are '
  'intentionally deferred to a separate migration (see review notes).';

-- ============================================================
-- contacts
-- Canonical person record. Instagram identity is fully optional so the
-- CRM works for phone/walk-in/referral contacts with no Instagram trace.
-- ============================================================

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (length(trim(full_name)) > 0),
  phone text,
  email text,
  instagram_username text,
  instagram_user_id text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.contacts is
  'Canonical person record. Instagram identity is optional and never required.';

create index contacts_phone_idx
  on public.contacts (phone) where phone is not null;

create index contacts_email_idx
  on public.contacts (email) where email is not null;

create index contacts_instagram_username_idx
  on public.contacts (instagram_username) where instagram_username is not null;

-- instagram_user_id is an immutable external identity (unlike username,
-- which can change), so it is safe to enforce as unique when present.
create unique index contacts_instagram_user_id_key
  on public.contacts (instagram_user_id) where instagram_user_id is not null;

-- ============================================================
-- leads
-- Sales opportunity linked to a contact. Stage is a snapshot; full
-- transition history lives in lead_stage_events.
-- ============================================================

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  stage public.lead_stage not null default 'NEW',
  stage_changed_at timestamptz not null default now(),
  interested_service public.service_type,
  lost_reason public.lead_lost_reason,
  assigned_to uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leads_lost_reason_requires_lost_stage
    check (lost_reason is null or stage = 'LOST')
);

comment on table public.leads is
  'Sales opportunity for a contact. Pipeline stage is independent of follow-up tasks.';

create index leads_contact_id_idx on public.leads (contact_id);
create index leads_stage_idx on public.leads (stage);
create index leads_assigned_to_idx
  on public.leads (assigned_to) where assigned_to is not null;
create index leads_created_at_idx on public.leads (created_at);

-- ============================================================
-- lead_stage_events
-- Append-only history of pipeline stage changes.
-- ============================================================

create table public.lead_stage_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  from_stage public.lead_stage,
  to_stage public.lead_stage not null,
  changed_at timestamptz not null default now(),
  changed_by uuid references public.app_users(id) on delete set null,
  note text
);

comment on table public.lead_stage_events is
  'Append-only history of lead pipeline stage transitions.';

create index lead_stage_events_lead_id_idx
  on public.lead_stage_events (lead_id, changed_at);

-- ============================================================
-- touchpoints
-- Attribution/touchpoint history for a lead. Zero rows is valid (no
-- fabricated attribution). external_ref is a thin pointer only (e.g. an
-- Instagram comment/media id or a future Meta lead-form submission id) —
-- never a copy of Instagram MCP content or analytics.
-- ============================================================

create table public.touchpoints (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  channel public.touchpoint_channel not null,
  certainty public.attribution_certainty not null default 'UNKNOWN',
  occurred_at timestamptz,
  source_detail text,
  external_ref text,
  is_primary boolean not null default false,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.touchpoints is
  'Attribution touchpoints for a lead (0..many). external_ref is a thin external '
  'reference only — never a duplication of Instagram MCP content or analytics.';

create index touchpoints_lead_id_idx on public.touchpoints (lead_id);

-- Enforces "at most one primary touchpoint per lead" at the database level.
create unique index touchpoints_one_primary_per_lead
  on public.touchpoints (lead_id) where is_primary;

-- ============================================================
-- customers
-- One customer per contact. Created when a lead is WON; reused for any
-- future purchase by the same contact so a person is never recreated.
-- ============================================================

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null unique references public.contacts(id) on delete restrict,
  customer_since date not null default current_date,
  status public.customer_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.customers is
  'Marks a contact as a paying customer (unique contact_id). '
  'ON DELETE RESTRICT on contact_id protects financial history from accidental loss.';

create index customers_status_idx on public.customers (status);

-- ============================================================
-- follow_up_tasks
-- Follow-ups are independent of pipeline stage. A task belongs to
-- exactly one of lead_id / customer_id. "Overdue" is intentionally NOT
-- stored — it is derived as: status = 'PENDING' AND due_at < now().
-- ============================================================

create table public.follow_up_tasks (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.leads(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  notes text,
  due_at timestamptz not null,
  status public.task_status not null default 'PENDING',
  completed_at timestamptz,
  completed_note text,
  source public.task_source not null default 'MANUAL',
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint follow_up_tasks_exactly_one_parent check (
    (lead_id is not null and customer_id is null)
    or (lead_id is null and customer_id is not null)
  ),
  constraint follow_up_tasks_completed_at_consistency check (
    (status = 'COMPLETED' and completed_at is not null)
    or (status <> 'COMPLETED' and completed_at is null)
  )
);

comment on table public.follow_up_tasks is
  'Follow-up tasks, independent of lead pipeline stage. Exactly one of '
  'lead_id/customer_id is set. Overdue is computed, never stored.';

create index follow_up_tasks_lead_id_idx
  on public.follow_up_tasks (lead_id) where lead_id is not null;
create index follow_up_tasks_customer_id_idx
  on public.follow_up_tasks (customer_id) where customer_id is not null;

-- Supports the core overdue-detection query efficiently.
create index follow_up_tasks_pending_due_idx
  on public.follow_up_tasks (due_at) where status = 'PENDING';

-- ============================================================
-- purchases
-- The agreed deal: what was sold, at what price, starting when.
-- ============================================================

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  lead_id uuid references public.leads(id) on delete set null,
  service_type public.service_type not null,
  custom_service_name text,
  -- Integer minor units (agorot for ILS). Never floating point.
  agreed_price_amount integer not null check (agreed_price_amount >= 0),
  agreed_price_currency char(3) not null default 'ILS'
    check (agreed_price_currency ~ '^[A-Z]{3}$'),
  recurrence public.purchase_recurrence not null default 'ONE_TIME',
  start_date date not null,
  status public.purchase_status not null default 'ACTIVE',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint purchases_custom_service_name_when_other check (
    (service_type = 'OTHER'
      and custom_service_name is not null
      and length(trim(custom_service_name)) > 0)
    or (service_type <> 'OTHER')
  )
);

comment on table public.purchases is
  'Agreed deal: service, agreed price, start date. lead_id is provenance only '
  '(ON DELETE SET NULL) so deleting a lead never deletes revenue history. '
  'ON DELETE RESTRICT on customer_id preserves financial history.';

create index purchases_customer_id_idx on public.purchases (customer_id);
create index purchases_lead_id_idx
  on public.purchases (lead_id) where lead_id is not null;
create index purchases_status_idx on public.purchases (status);

-- ============================================================
-- payments
-- Append-only revenue ledger linked to a purchase. Rows are preserved as
-- history; a refund is recorded by updating status, never by deletion.
-- ============================================================

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases(id) on delete restrict,
  -- Integer minor units (agorot for ILS). Never floating point.
  amount integer not null check (amount >= 0),
  currency char(3) not null default 'ILS' check (currency ~ '^[A-Z]{3}$'),
  paid_at date not null,
  method public.payment_method not null,
  status public.payment_status not null default 'PAID',
  notes text,
  created_at timestamptz not null default now()
);

comment on table public.payments is
  'Append-only revenue ledger. ON DELETE RESTRICT on purchase_id prevents a '
  'purchase from being deleted while payment history exists.';

create index payments_purchase_id_idx on public.payments (purchase_id);
create index payments_paid_at_idx on public.payments (paid_at);
create index payments_status_idx on public.payments (status);

-- ============================================================
-- updated_at maintenance
-- ============================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_updated_at
  before update on public.app_users
  for each row execute function public.set_updated_at();

create trigger set_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

create trigger set_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

create trigger set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

create trigger set_updated_at
  before update on public.follow_up_tasks
  for each row execute function public.set_updated_at();

create trigger set_updated_at
  before update on public.purchases
  for each row execute function public.set_updated_at();

-- ============================================================
-- Row Level Security
--
-- RLS is enabled on every CRM table below with NO policies defined.
-- With RLS enabled and zero policies:
--   - Postgres roles with BYPASSRLS (the Supabase `service_role`, and the
--     `postgres`/migration-owner role) can still read/write normally.
--   - The `anon` and `authenticated` API roles — i.e. any access coming
--     through the Supabase client libraries with the anon/publishable or
--     a user JWT — get ZERO rows and cannot insert/update/delete anything,
--     because no policy grants them permission.
-- This is deliberate: no permissive anonymous policy is created here.
-- A future migration will add real auth-based policies once the app's
-- access model (who is "Gal" as an authenticated user, staff roles, etc.)
-- is defined.
-- ============================================================

alter table public.app_users enable row level security;
alter table public.contacts enable row level security;
alter table public.leads enable row level security;
alter table public.lead_stage_events enable row level security;
alter table public.touchpoints enable row level security;
alter table public.customers enable row level security;
alter table public.follow_up_tasks enable row level security;
alter table public.purchases enable row level security;
alter table public.payments enable row level security;
