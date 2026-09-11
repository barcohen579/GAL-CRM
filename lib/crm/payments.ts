// Pure validation helpers for manually recording a Payment
// (app/(app)/payments/actions.ts::recordPayment). Extracted so the
// actual rules are unit-testable under `node --test` — recordPayment
// itself can't be (it's a "use server" action that calls
// lib/supabase/server.ts's createClient(), which needs a real Next.js
// request scope; see the previous session's notes on this exact
// constraint). This file has zero Supabase/Next imports.

export type ParsedManualPaymentInput =
  | { error: string }
  | {
      purchaseId: string;
      customerId: string | null;
      amountMinor: number;
      paidAt: string;
      method: string;
      status: string;
      notes: string | null;
    };

export type RawManualPaymentFields = {
  purchaseId: string | null;
  customerId: string | null;
  amountRaw: string | null;
  paidAt: string | null;
  method: string | null;
  status: string | null;
  notes: string | null;
};

// Same validation `recordPayment` has always done inline: purchase and
// amount and date and method are required; amount is parsed as ₪ and
// converted to integer agorot (never a float — same convention as every
// other money field in this codebase); status defaults to PAID (a
// manually recorded payment is real revenue unless told otherwise);
// notes is optional and only meaningful because payments.notes already
// exists on the schema (see prevent_payment_fact_changes — notes is one
// of the two columns that may ever change after insert).
export function parseManualPaymentInput(fields: RawManualPaymentFields): ParsedManualPaymentInput {
  if (!fields.purchaseId) return { error: "יש לבחור רכישה." };
  if (!fields.amountRaw) return { error: "יש להזין סכום." };

  const amountNis = Number(fields.amountRaw.replace(/,/g, ""));
  if (!Number.isFinite(amountNis) || amountNis < 0) {
    return { error: "הסכום שהוזן אינו תקין." };
  }
  const amountMinor = Math.round(amountNis * 100);

  if (!fields.paidAt) return { error: "יש לבחור תאריך תשלום." };
  if (!fields.method) return { error: "יש לבחור אמצעי תשלום." };

  return {
    purchaseId: fields.purchaseId,
    customerId: fields.customerId,
    amountMinor,
    paidAt: fields.paidAt,
    method: fields.method,
    status: fields.status ?? "PAID",
    notes: fields.notes,
  };
}

// A manually entered payment MUST attach to a Purchase that genuinely
// belongs to the Customer the form claims it's for — never trust the
// submitted purchase_id alone. Only enforced when a customerId is
// actually present on the submission (the existing customer-detail-page
// RecordPaymentDialog flow always sends one; a caller that legitimately
// has no customer context in scope is not newly broken by this check).
export function validatePurchaseOwnership(
  purchase: { customer_id: string } | null,
  customerId: string | null
): { ok: true } | { ok: false; error: string } {
  if (!purchase) return { ok: false, error: "הרכישה שנבחרה לא נמצאה." };
  if (customerId && purchase.customer_id !== customerId) {
    return { ok: false, error: "הרכישה שנבחרה אינה שייכת ללקוחה שנבחרה." };
  }
  return { ok: true };
}
