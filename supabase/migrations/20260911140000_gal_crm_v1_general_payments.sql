-- GAL CRM V1 — General (non-Customer/Purchase) manual payments
--
-- Extends payments to support a second payment type: real PAID revenue
-- that isn't tied to any specific Customer/Purchase (a one-off workshop,
-- event income, ...). Previously purchase_id was required on every
-- payment — a payment was structurally reachable ONLY through a
-- Purchase, with no customer_id column of its own at all.
--
-- Design: nullable purchase_id + an explicit payment_context
-- discriminator ('CUSTOMER' | 'GENERAL'), enforced by CHECK constraints
-- rather than inferred from nullability alone — see the task's own
-- "implement it explicitly and safely" guidance. This is the smallest
-- additive change: no new table, no new RLS policy (is_crm_user() is
-- unaffected by column nullability), no change to
-- payments_purchase_billing_cycle_key (GENERAL payments never carry a
-- billing_cycle) or to generate_due_recurring_payments()/
-- create_customer_directly() (both always insert purchase_id, so they
-- pick up the new column's default of 'CUSTOMER' automatically, with no
-- function change needed).
--
-- Existing rows: the ADD COLUMN ... NOT NULL DEFAULT 'CUSTOMER' below
-- backfills every existing payment to CUSTOMER (correct — every payment
-- that exists today genuinely IS customer/purchase-linked) without
-- altering any of its financial facts (amount/paid_at/method/etc.
-- untouched) — same precedent as is_auto_generated's own earlier
-- column addition.

create type public.payment_context as enum ('CUSTOMER', 'GENERAL');

alter table public.payments alter column purchase_id drop not null;

alter table public.payments
  add column payment_context public.payment_context not null default 'CUSTOMER';

comment on column public.payments.payment_context is
  'CUSTOMER: linked to a real purchase_id (the original, only payment '
  'shape). GENERAL: real PAID revenue not tied to any Customer/Purchase '
  '(e.g. a one-off workshop) -- purchase_id is null, a description is '
  'required in notes. Never inferred from nullability alone -- see '
  'payments_context_purchase_shape below.';

-- Makes an inconsistent row impossible at the DB level: a CUSTOMER
-- payment must have a real purchase, a GENERAL payment must not.
alter table public.payments add constraint payments_context_purchase_shape check (
  (payment_context = 'CUSTOMER' and purchase_id is not null) or
  (payment_context = 'GENERAL' and purchase_id is null)
);

-- A GENERAL payment carries no service/customer of its own to explain
-- what it was for later -- the task requires a description to be
-- mandatory, enforced here (not just in the UI/Server Action) so it can
-- never be bypassed.
alter table public.payments add constraint payments_general_requires_description check (
  payment_context <> 'GENERAL' or (notes is not null and length(btrim(notes)) > 0)
);

create index payments_context_idx on public.payments (payment_context);

-- Extend the append-only ledger guard (see
-- 20260902083853_..._authorization_rls.sql for the original) to also
-- protect payment_context -- it is as much a financial fact as
-- purchase_id/amount/etc. and must never be silently switched after
-- creation. Same "applies to every role, including service_role" design
-- as the original function; only the guarded column list changes.
create or replace function public.prevent_payment_fact_changes()
returns trigger
language plpgsql
as $$
begin
  if new.purchase_id is distinct from old.purchase_id
     or new.payment_context is distinct from old.payment_context
     or new.amount is distinct from old.amount
     or new.currency is distinct from old.currency
     or new.paid_at is distinct from old.paid_at
     or new.method is distinct from old.method
     or new.created_at is distinct from old.created_at
  then
    raise exception
      'payments: purchase_id, payment_context, amount, currency, paid_at, '
      'method and created_at cannot be modified after creation — only '
      'status and notes may change';
  end if;
  return new;
end;
$$;

comment on function public.prevent_payment_fact_changes() is
  'Guards payments append-only integrity at the column level: once written, '
  'only status and notes may change. Applies to every role (no service_role '
  'exemption) so no normal code path can rewrite recorded financial facts, '
  'including which payment_context/purchase a row was recorded against.';
