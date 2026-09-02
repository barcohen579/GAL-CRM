"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

function optionalString(value: FormDataEntryValue | null): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > 0 ? s : null;
}

export type RecordPaymentState = { error: string | null; success?: boolean };

// Only ever INSERTs. The payments table has an append-only ledger
// trigger (prevent_payment_fact_changes) that blocks amount/currency/
// purchase_id/paid_at/method/created_at from ever being edited after
// creation — this action respects that by design: it has no update
// path at all. A correction means a new payment row (e.g. a REFUNDED
// entry), never editing this one.
export async function recordPayment(
  _prevState: RecordPaymentState,
  formData: FormData
): Promise<RecordPaymentState> {
  const purchaseId = optionalString(formData.get("purchase_id"));
  const customerId = optionalString(formData.get("customer_id"));
  const amountRaw = optionalString(formData.get("amount"));
  const paidAt = optionalString(formData.get("paid_at"));
  const method = optionalString(formData.get("method"));
  const status = optionalString(formData.get("status")) ?? "PAID";
  const notes = optionalString(formData.get("notes"));

  if (!purchaseId) return { error: "יש לבחור רכישה." };
  if (!amountRaw) return { error: "יש להזין סכום." };

  const amountNis = Number(amountRaw.replace(/,/g, ""));
  if (!Number.isFinite(amountNis) || amountNis < 0) {
    return { error: "הסכום שהוזן אינו תקין." };
  }
  // ₪ -> integer agorot. Never store money as a float.
  const amount = Math.round(amountNis * 100);

  if (!paidAt) return { error: "יש לבחור תאריך תשלום." };
  if (!method) return { error: "יש לבחור אמצעי תשלום." };

  const supabase = await createClient();
  const { error } = await supabase.from("payments").insert({
    purchase_id: purchaseId,
    amount,
    currency: "ILS",
    paid_at: paidAt,
    method,
    status,
    notes,
  });

  if (error) {
    return { error: `לא הצלחנו לשמור את התשלום: ${error.message}` };
  }

  revalidatePath("/payments");
  revalidatePath("/dashboard");
  revalidatePath("/customers");
  if (customerId) revalidatePath(`/customers/${customerId}`);

  return { error: null, success: true };
}
