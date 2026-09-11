"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { firstOfMonth } from "@/lib/crm/recurring";
import { parseManualPaymentInput, validatePurchaseOwnership } from "@/lib/crm/payments";

function optionalString(value: FormDataEntryValue | null): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > 0 ? s : null;
}

// Postgres unique_violation — surfaced when a manually-recorded
// payment collides with payments_purchase_billing_cycle_key (a cycle
// already has a payment, auto-generated or manual).
const UNIQUE_VIOLATION = "23505";

export type RecordPaymentState = { error: string | null; success?: boolean };

// Only ever INSERTs a NEW payment row. The payments table has an
// append-only ledger trigger (prevent_payment_fact_changes) that
// blocks amount/currency/purchase_id/paid_at/method/created_at from
// ever being edited after creation — this action respects that by
// design: it has no update path at all. Correcting an EXISTING
// payment (e.g. an auto-generated one that turned out unpaid) is a
// separate action, markPaymentUnpaid below, which only ever flips
// status/notes on a row that already exists — never insert-vs-update
// ambiguity within this one function.
export async function recordPayment(
  _prevState: RecordPaymentState,
  formData: FormData
): Promise<RecordPaymentState> {
  const parsed = parseManualPaymentInput({
    purchaseId: optionalString(formData.get("purchase_id")),
    customerId: optionalString(formData.get("customer_id")),
    amountRaw: optionalString(formData.get("amount")),
    paidAt: optionalString(formData.get("paid_at")),
    method: optionalString(formData.get("method")),
    status: optionalString(formData.get("status")),
    notes: optionalString(formData.get("notes")),
  });
  if ("error" in parsed) return { error: parsed.error };
  const { purchaseId, customerId, amountMinor: amount, paidAt, method, status, notes } = parsed;

  const supabase = await createClient();

  // If this purchase is an ACTIVE recurring one, this manually-entered
  // payment ALSO occupies that month's billing_cycle slot — exactly
  // like the auto-generated case — so the scheduled job can never
  // double-bill this same month later (see
  // payments_purchase_billing_cycle_key). Not applied to a ONE_TIME or
  // stopped purchase, where the concept doesn't apply.
  //
  // Also carries customer_id, so a payment can never be attached to a
  // Purchase that doesn't actually belong to the Customer the form was
  // submitted for (see validatePurchaseOwnership) — this is the one
  // thing the UI's own purchase picker can't guarantee on its own, since
  // a submission is just a purchase_id string by the time it gets here.
  const { data: purchase } = await supabase
    .from("purchases")
    .select("recurrence, status, customer_id")
    .eq("id", purchaseId)
    .maybeSingle();

  const ownership = validatePurchaseOwnership(purchase, customerId);
  if (!ownership.ok) return { error: ownership.error };

  const billingCycle =
    purchase?.recurrence === "RECURRING_MONTHLY" && purchase.status === "ACTIVE"
      ? firstOfMonth(paidAt)
      : null;

  const { error } = await supabase.from("payments").insert({
    purchase_id: purchaseId,
    amount,
    currency: "ILS",
    paid_at: paidAt,
    method,
    status,
    notes,
    billing_cycle: billingCycle,
    is_auto_generated: false,
  });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return { error: "כבר נרשם תשלום עבור חודש זה ברכישה הזו." };
    }
    return { error: `לא הצלחנו לשמור את התשלום: ${error.message}` };
  }

  revalidatePath("/payments");
  revalidatePath("/dashboard");
  revalidatePath("/customers");
  if (customerId) revalidatePath(`/customers/${customerId}`);

  return { error: null, success: true };
}

// "לא שילמה החודש" — corrects an EXISTING PAID payment (typically
// auto-generated, but works for any) to FAILED after the fact, when
// the assumed/expected monthly payment turns out not to have actually
// happened. This is an UPDATE, not a new row — but only ever touches
// status/notes, the two columns prevent_payment_fact_changes has
// always allowed to change (this is the exact same mechanism that has
// always powered a REFUNDED correction in this schema; nothing new at
// the trigger level). amount/paid_at/purchase_id/billing_cycle/
// created_at remain permanently exactly as originally recorded —
// auditable and traceable, never rewritten or deleted.
//
// Deliberately does NOT touch the purchase's recurrence/status/
// next_billing_date: "she didn't pay this month" is not the same
// decision as "stop the recurring service" (see stopRecurringBilling
// in app/(app)/customers/actions.ts) — next month's cycle still
// generates normally unless a SEPARATE stop action is taken.
//
// Guarded to only apply to a currently-PAID payment (idempotent no-op
// protection: cannot "un-fail" or double-correct through this action).
export async function markPaymentUnpaid(
  paymentId: string,
  customerId: string
): Promise<{ error: string | null }> {
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("payments")
    .select("notes")
    .eq("id", paymentId)
    .maybeSingle();
  const correctionNote = "לא שילמה החודש";
  const notes = existing?.notes ? `${correctionNote} — ${existing.notes}` : correctionNote;

  const { error } = await supabase
    .from("payments")
    .update({ status: "FAILED", notes })
    .eq("id", paymentId)
    .eq("status", "PAID");

  if (error) {
    return { error: `לא הצלחנו לעדכן את התשלום: ${error.message}` };
  }

  revalidatePath("/payments");
  revalidatePath("/dashboard");
  revalidatePath("/customers");
  if (customerId) revalidatePath(`/customers/${customerId}`);

  return { error: null };
}
