-- GAL CRM V1 — automatic monthly recurring services & payments:
-- the scheduled-generation function.
--
-- public.generate_due_recurring_payments() is the ENTIRE server-side
-- job. Called once per day by app/api/cron/recurring-billing/route.ts
-- (a Vercel Cron job, authenticated via CRON_SECRET — see that route
-- for the HTTP-layer security) via the service_role admin client —
-- never by an authenticated CRM user, and never reachable from the
-- browser. It has no input: it finds every purchase whose next cycle
-- is due, generates it, and self-schedules the following cycle.
--
-- SECURITY INVOKER, not DEFINER: the only intended caller is
-- service_role, which already has exactly the grants this function
-- needs (below) and bypasses RLS entirely — there is nothing for a
-- DEFINER's elevated privilege to add, and INVOKER carries none of a
-- DEFINER's privilege-escalation surface. EXECUTE is revoked from
-- PUBLIC and from `authenticated` (see grants below) — an ordinary CRM
-- user, and the browser, can never invoke this function at all,
-- regardless of the HTTP-layer CRON_SECRET check.
--
-- Idempotency and catch-up:
--   For each due purchase, cycles are generated one at a time in a
--   loop while next_billing_date <= current_date — so a job that
--   hasn't run in weeks correctly backfills every missed month, not
--   just the most recent one. Each cycle's INSERT + next_billing_date
--   advance happens inside its own nested BEGIN/EXCEPTION block (an
--   implicit savepoint): if generating one cycle for one purchase
--   somehow fails, that failure is isolated to THAT cycle only —
--   already-generated earlier cycles for the same purchase, and every
--   other purchase in this run, are unaffected. The actual duplicate-
--   prevention guarantee is the unique index from the schema
--   migration (payments_purchase_billing_cycle_key), applied via
--   INSERT ... ON CONFLICT DO NOTHING here — not this function's own
--   care, which is what makes concurrent/repeated execution safe even
--   if this function itself were ever called from two places at once.
--   FOR UPDATE OF p additionally serializes concurrent executions
--   against each other at the row level, purely to avoid wasted
--   duplicate work under real concurrency — the correctness guarantee
--   itself is the unique index regardless.
--
--   next_billing_date is advanced (to one calendar month after the
--   cycle just handled) unconditionally after each INSERT attempt —
--   whether that INSERT actually created a new row or hit the unique
--   conflict because a payment for that cycle already existed (e.g.
--   Gal recorded it manually ahead of time via "רישום תשלום"). Either
--   way, that cycle is "handled" and billing correctly moves on to the
--   next month — this is what makes a manually pre-recorded payment
--   for the current cycle never get duplicated by this job.
--
--   paid_at is set to the CYCLE's own first-of-month date, not
--   "today" (the day the job actually happened to run) — so a
--   catch-up run on, say, October 5th for a September cycle that was
--   missed still books that payment as September revenue, exactly
--   matching what the dashboard's month-by-month reporting expects
--   (see lib/crm/marketing.ts::buildMonthlyMetrics, unchanged by this
--   feature — it already aggregates any PAID payment by its paid_at
--   month, auto-generated or not).
--
--   method is always 'OTHER': this CRM records ASSUMED/expected
--   payments for bookkeeping, not real charges — the actual real-world
--   payment method for a given month isn't collected anywhere upstream
--   for an auto-generated cycle, so 'OTHER' is the honest choice
--   (never a guess like CASH/CARD/BIT/BANK_TRANSFER that isn't
--   actually known). is_auto_generated = true is the real, queryable
--   signal that this was assumed rather than manually confirmed.
--
-- Returns one row per payment ACTUALLY created this run (never a row
-- for a cycle that hit the conflict) — used only for the cron route's
-- own logging/response summary, never exposed publicly beyond counts.
--
-- Output columns are prefixed "out_" — DELIBERATELY not just
-- purchase_id/billing_cycle/etc — because this schema has already hit
-- the exact same Postgres gotcha twice before (see
-- delete_lead_safely() and create_customer_directly()'s own comments):
-- a RETURNS TABLE column sharing a name with a real table column
-- becomes ambiguous (42702) wherever that bare identifier appears
-- inside this function's embedded SQL — and here it's worse than an
-- unqualified SELECT/WHERE, because it silently miscompiles the
-- ON CONFLICT (...) WHERE inference predicate below, which then throws
-- 42702 at RUNTIME on every attempted insert, gets caught by this
-- function's own per-cycle exception handler, and would otherwise look
-- exactly like "nothing was due" — confirmed live during development:
-- with unprefixed output columns this function silently generated
-- ZERO payments for an obviously-due purchase. Prefixing avoids the
-- whole class of this bug rather than relying on qualifying every
-- reference correctly by hand.

create or replace function public.generate_due_recurring_payments()
returns table (
  out_purchase_id uuid,
  out_payment_id uuid,
  out_customer_id uuid,
  out_billing_cycle date,
  out_amount integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_purchase record;
  v_cycle date;
  v_payment_id uuid;
begin
  for v_purchase in
    select p.id, p.customer_id, p.agreed_price_amount, p.agreed_price_currency, p.next_billing_date
    from public.purchases p
    where p.recurrence = 'RECURRING_MONTHLY'
      and p.status = 'ACTIVE'
      and p.next_billing_date is not null
      and p.next_billing_date <= current_date
    order by p.id
    for update of p
  loop
    v_cycle := v_purchase.next_billing_date;

    while v_cycle <= current_date loop
      begin
        v_payment_id := null;

        insert into public.payments (
          purchase_id, amount, currency, paid_at, method, status,
          billing_cycle, is_auto_generated
        )
        values (
          v_purchase.id, v_purchase.agreed_price_amount, v_purchase.agreed_price_currency,
          v_cycle, 'OTHER', 'PAID',
          v_cycle, true
        )
        on conflict (purchase_id, billing_cycle) where billing_cycle is not null
        do nothing
        returning id into v_payment_id;

        update public.purchases
        set next_billing_date = (date_trunc('month', v_cycle) + interval '1 month')::date
        where id = v_purchase.id;

        if v_payment_id is not null then
          out_purchase_id := v_purchase.id;
          out_payment_id := v_payment_id;
          out_customer_id := v_purchase.customer_id;
          out_billing_cycle := v_cycle;
          out_amount := v_purchase.agreed_price_amount;
          return next;
        end if;
      exception when others then
        -- Isolated via the implicit savepoint this block creates: stop
        -- processing further cycles for THIS purchase (next_billing_date
        -- was not advanced past v_cycle, so tomorrow's run retries it
        -- from exactly here), but every other purchase in this loop is
        -- entirely unaffected.
        raise warning 'generate_due_recurring_payments: failed for purchase % cycle %: %',
          v_purchase.id, v_cycle, sqlerrm;
        exit;
      end;

      v_cycle := (date_trunc('month', v_cycle) + interval '1 month')::date;
    end loop;
  end loop;

  return;
end;
$$;

comment on function public.generate_due_recurring_payments() is
  'Scheduled job body: generates every due monthly cycle for every '
  'ACTIVE RECURRING_MONTHLY purchase, backfilling any missed months, '
  'exactly once per (purchase_id, billing_cycle) no matter how many '
  'times or how concurrently this is called (enforced by the '
  'payments_purchase_billing_cycle_key unique index, not by this '
  'function''s own logic). Called only by service_role via '
  'app/api/cron/recurring-billing/route.ts.';

revoke all on function public.generate_due_recurring_payments() from public;
revoke all on function public.generate_due_recurring_payments() from authenticated;
grant execute on function public.generate_due_recurring_payments() to service_role;

-- ============================================================
-- service_role grants
--
-- This project has automatic-RLS-with-default-grants disabled (see
-- 20260903005457_gal_crm_v1_meta_lead_ingestion.sql for the
-- established precedent and full rationale) — service_role gets no
-- privileges on any table, including purchases/payments, until
-- explicitly granted. Exactly what generate_due_recurring_payments()
-- needs and no more:
--
--   purchases -> SELECT (find due purchases), UPDATE (advance
--                next_billing_date). No INSERT/DELETE — this job never
--                creates or removes a purchase, only ever an existing
--                recurring one's billing pointer.
--   payments  -> SELECT, INSERT (create the cycle's payment row; SELECT
--                is additionally required for the RETURNING clause to
--                read back the new id). No UPDATE/DELETE — this job
--                never touches an existing payment, including one it
--                created on an earlier run.
-- ============================================================

grant select, update on public.purchases to service_role;

grant select, insert on public.payments to service_role;
