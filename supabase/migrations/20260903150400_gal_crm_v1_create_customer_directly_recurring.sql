-- GAL CRM V1 — teach create_customer_directly about recurring billing
--
-- Adds one optional parameter, p_next_billing_date, so the "הוספת
-- לקוחה" flow can create a customer whose very first service is
-- already a monthly recurring one — without a second trip through
-- "הפעלת חיוב חודשי" afterward. p_recurrence already existed as a
-- parameter (every prior caller just always passed 'ONE_TIME'); this
-- migration only adds the missing piece: WHERE the recurring schedule
-- should start.
--
-- DROP + CREATE (not a bare CREATE OR REPLACE) — same reason as the
-- referral migration before this one: adding a parameter, even with a
-- DEFAULT, is a different signature to Postgres, not a replacement of
-- the existing one.
--
-- Idempotency note: when a first payment is ALSO recorded in this same
-- call (p_payment_amount is not null) and p_recurrence is
-- RECURRING_MONTHLY, that payment's billing_cycle is set to the
-- first-of-month of p_payment_paid_at — occupying that cycle's slot in
-- payments_purchase_billing_cycle_key exactly like any other cycle
-- payment, manual or automatic. p_next_billing_date is expected to
-- already point at the FOLLOWING month in that case (the caller —
-- app/(app)/customers/actions.ts — computes this), so
-- generate_due_recurring_payments() never tries to re-generate the
-- cycle this call just recorded by hand.

drop function if exists public.create_customer_directly(
  uuid, text, text, text, text, public.service_type, text, text, integer,
  public.purchase_recurrence, date, integer, date, public.payment_method, text, uuid
);

create or replace function public.create_customer_directly(
  p_matched_contact_id uuid,
  p_full_name text,
  p_phone text,
  p_email text,
  p_instagram_username text,
  p_service_type public.service_type,
  p_custom_service_name text,
  p_purchase_notes text,
  p_agreed_price_amount integer,
  p_recurrence public.purchase_recurrence,
  p_start_date date,
  p_payment_amount integer,
  p_payment_paid_at date,
  p_payment_method public.payment_method,
  p_payment_notes text,
  p_referrer_customer_id uuid default null,
  p_next_billing_date date default null
)
returns table (
  contact_id uuid,
  customer_id uuid,
  purchase_id uuid,
  payment_id uuid,
  created_new_contact boolean,
  created_new_customer boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_contact_id uuid;
  v_customer_id uuid;
  v_purchase_id uuid;
  v_payment_id uuid;
  v_created_new_contact boolean := false;
  v_created_new_customer boolean := false;
  v_next_billing_date date;
  v_payment_billing_cycle date;
begin
  if p_full_name is null or length(trim(p_full_name)) = 0 then
    raise exception 'Full name is required';
  end if;

  if p_service_type = 'OTHER'
     and (p_custom_service_name is null or length(trim(p_custom_service_name)) = 0) then
    raise exception 'Custom service name is required when service_type is OTHER';
  end if;

  if p_agreed_price_amount is null or p_agreed_price_amount < 0 then
    raise exception 'A valid agreed price is required';
  end if;

  if p_start_date is null then
    raise exception 'A start date is required';
  end if;

  if p_recurrence = 'RECURRING_MONTHLY' and p_next_billing_date is null then
    raise exception 'A next billing date is required for a recurring monthly purchase';
  end if;

  -- Contact: reuse the caller-matched contact (filling in ONLY
  -- currently-missing fields — never overwrites existing data, same
  -- rule as the Meta ingestion pipeline's fill-in-only behavior), or
  -- create a new one.
  if p_matched_contact_id is not null then
    v_contact_id := p_matched_contact_id;
    update public.contacts
    set phone = case when phone is null and p_phone is not null then p_phone else phone end,
        email = case when email is null and p_email is not null then p_email else email end,
        instagram_username = case
          when instagram_username is null and p_instagram_username is not null
          then p_instagram_username else instagram_username
        end,
        updated_at = now()
    where id = v_contact_id;
  else
    insert into public.contacts (full_name, phone, email, instagram_username)
    values (p_full_name, p_phone, p_email, p_instagram_username)
    returning id into v_contact_id;
    v_created_new_contact := true;
  end if;

  -- Referral: recorded against the CONTACT, independent of the
  -- Customer/Purchase below — see the referral migration's own header
  -- comment for the ON CONFLICT / self-referral rationale.
  if p_referrer_customer_id is not null then
    insert into public.referrals (referred_contact_id, referrer_customer_id)
    values (v_contact_id, p_referrer_customer_id)
    on conflict (referred_contact_id) do nothing;
  end if;

  -- Customer: find-or-create for this contact — identical logic to
  -- convert_lead_to_won, so re-running this for an already-existing
  -- customer reuses her profile instead of duplicating it. Table-
  -- qualified ("cust.contact_id") because this function's own
  -- RETURNS TABLE output includes a column also named contact_id,
  -- which PL/pgSQL otherwise treats as an in-scope variable here —
  -- an unqualified reference is genuinely ambiguous (confirmed live:
  -- 42702) between that output column and this table's own column.
  select id into v_customer_id
  from public.customers cust
  where cust.contact_id = v_contact_id;

  if v_customer_id is null then
    insert into public.customers (contact_id, customer_since, status)
    values (v_contact_id, p_start_date, 'ACTIVE')
    returning id into v_customer_id;
    v_created_new_customer := true;
  end if;

  -- Purchase: lead_id is always NULL here — this purchase never
  -- originated from a Lead, by design. next_billing_date is set ONLY
  -- for a recurring purchase, normalized to the first of its month
  -- (defensively — the caller is expected to already pass a
  -- first-of-month date; payments_billing_cycle_is_month_start-style
  -- normalization here costs nothing and guards against a
  -- not-quite-normalized caller value ever reaching the CHECK
  -- constraint as a hard failure instead).
  v_next_billing_date := case
    when p_recurrence = 'RECURRING_MONTHLY' then date_trunc('month', p_next_billing_date)::date
    else null
  end;

  insert into public.purchases (
    customer_id, lead_id, service_type, custom_service_name,
    agreed_price_amount, agreed_price_currency, recurrence,
    start_date, status, notes, next_billing_date
  )
  values (
    v_customer_id, null, p_service_type, p_custom_service_name,
    p_agreed_price_amount, 'ILS', p_recurrence,
    p_start_date, 'ACTIVE', p_purchase_notes, v_next_billing_date
  )
  returning id into v_purchase_id;

  -- Optional first payment — status is always PAID: this is a direct
  -- record of money already received, the same assumption the rest of
  -- this quick-entry flow makes (a REFUNDED/FAILED correction remains
  -- a separate, later action via the existing "רישום תשלום" dialog,
  -- exactly like any other payment). For a recurring purchase, this
  -- payment's billing_cycle is set to its own paid_at month — occupying
  -- that cycle so the scheduled job never re-generates it (see
  -- payments_purchase_billing_cycle_key).
  if p_payment_amount is not null then
    if p_payment_amount < 0 then
      raise exception 'Payment amount must not be negative';
    end if;
    if p_payment_paid_at is null then
      raise exception 'Payment date is required when a payment amount is given';
    end if;
    if p_payment_method is null then
      raise exception 'Payment method is required when a payment amount is given';
    end if;

    v_payment_billing_cycle := case
      when p_recurrence = 'RECURRING_MONTHLY' then date_trunc('month', p_payment_paid_at)::date
      else null
    end;

    insert into public.payments (
      purchase_id, amount, currency, paid_at, method, status, notes,
      billing_cycle, is_auto_generated
    )
    values (
      v_purchase_id, p_payment_amount, 'ILS', p_payment_paid_at, p_payment_method, 'PAID', p_payment_notes,
      v_payment_billing_cycle, false
    )
    returning id into v_payment_id;
  end if;

  return query
    select v_contact_id, v_customer_id, v_purchase_id, v_payment_id,
           v_created_new_contact, v_created_new_customer;
end;
$$;

comment on function public.create_customer_directly(
  uuid, text, text, text, text, public.service_type, text, text, integer,
  public.purchase_recurrence, date, integer, date, public.payment_method, text, uuid, date
) is
  'Atomically creates (or reuses) a Contact and Customer directly — no '
  'Lead, no Touchpoint, no fabricated attribution — plus a Purchase and '
  'an optional first Payment (status always PAID), an optional '
  'referrals row when p_referrer_customer_id is given, and (when '
  'p_recurrence = RECURRING_MONTHLY) sets purchases.next_billing_date '
  'from p_next_billing_date so the new purchase is immediately eligible '
  'for automatic monthly generation. Mirrors convert_lead_to_won''s '
  'find-or-create-customer / integer-agorot conventions. SECURITY '
  'INVOKER: relies entirely on the existing RLS policies and grants '
  'already in place for authenticated CRM users, the same as every '
  'other multi-table workflow function in this schema except '
  'delete_lead_safely.';

revoke all on function public.create_customer_directly(
  uuid, text, text, text, text, public.service_type, text, text, integer,
  public.purchase_recurrence, date, integer, date, public.payment_method, text, uuid, date
) from public;

grant execute on function public.create_customer_directly(
  uuid, text, text, text, text, public.service_type, text, text, integer,
  public.purchase_recurrence, date, integer, date, public.payment_method, text, uuid, date
) to authenticated;
