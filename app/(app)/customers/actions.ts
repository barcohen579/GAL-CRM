"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { findMatchingContactId } from "@/lib/crm/contact-matching";

function optionalString(value: FormDataEntryValue | null): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > 0 ? s : null;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export type CreateCustomerState = { error: string | null };

// Direct customer creation — the "הוספת לקוחה" flow. Deliberately does
// NOT create a Lead or a Touchpoint: this represents a customer who
// simply IS one already, not someone who passed through the sales
// pipeline, and fabricating either would invent attribution/pipeline
// history that never happened. All the real work (find-or-create
// Contact/Customer, create the Purchase and optional first Payment,
// atomically) happens in the create_customer_directly() RPC — see
// supabase/migrations/20260903105452_...sql for exactly what it does
// and why it's SECURITY INVOKER (unlike delete_lead_safely, every
// table this touches already has full INSERT policy + grant coverage
// for `authenticated`).
export async function createCustomerDirectly(
  _prevState: CreateCustomerState,
  formData: FormData
): Promise<CreateCustomerState> {
  const fullName = optionalString(formData.get("full_name"));
  if (!fullName) {
    return { error: "יש להזין שם מלא." };
  }

  const phone = optionalString(formData.get("phone"));
  const email = optionalString(formData.get("email"));
  const instagramUsername = optionalString(formData.get("instagram_username"));

  const serviceType = optionalString(formData.get("service_type"));
  if (!serviceType) {
    return { error: "יש לבחור שירות." };
  }
  const customServiceName = optionalString(formData.get("custom_service_name"));
  if (serviceType === "OTHER" && !customServiceName) {
    return { error: 'כשבוחרים "אחר" יש לפרט את שם השירות.' };
  }
  const purchaseNotes = optionalString(formData.get("purchase_notes"));

  const priceRaw = optionalString(formData.get("agreed_price"));
  if (!priceRaw) {
    return { error: "יש להזין מחיר מוסכם." };
  }
  const priceNis = Number(priceRaw.replace(/,/g, ""));
  if (!Number.isFinite(priceNis) || priceNis < 0) {
    return { error: "המחיר שהוזן אינו תקין." };
  }
  // ₪ -> integer agorot. Never store money as a float.
  const agreedPriceAmount = Math.round(priceNis * 100);

  // The optional first-payment section: amount/date/method travel
  // together — either all three are meaningfully present, or none are
  // (no payment is recorded at all, which the schema fully supports).
  const paymentAmountRaw = optionalString(formData.get("payment_amount"));
  const paymentPaidAtInput = optionalString(formData.get("payment_paid_at"));
  const paymentMethod = optionalString(formData.get("payment_method"));
  const paymentNotes = optionalString(formData.get("payment_notes"));

  let paymentAmount: number | null = null;
  let paymentPaidAt: string | null = null;
  if (paymentAmountRaw) {
    const paymentNis = Number(paymentAmountRaw.replace(/,/g, ""));
    if (!Number.isFinite(paymentNis) || paymentNis < 0) {
      return { error: "סכום התשלום שהוזן אינו תקין." };
    }
    paymentAmount = Math.round(paymentNis * 100);
    paymentPaidAt = paymentPaidAtInput ?? todayIso();
    if (!paymentMethod) {
      return { error: "יש לבחור אמצעי תשלום." };
    }
  }

  // Purchase start date: the historical payment date when one is
  // given (she plausibly started the service around when she first
  // paid for it — a sensible default for backfilling an existing
  // customer), otherwise today. Not asked as a separate form field —
  // keeps this a short flow, not an admin database form.
  const startDate = paymentPaidAt ?? todayIso();

  const supabase = await createClient();

  // Deterministic contact matching — normalized phone, then normalized
  // email, never by name (lib/crm/contact-matching.ts, reusing the
  // Meta pipeline's own normalization). Only reads columns
  // `authenticated` already has SELECT on; no service_role anywhere in
  // this flow.
  let matchedContactId: string | null = null;
  if (phone) {
    const { data } = await supabase
      .from("contacts")
      .select("id, phone, email")
      .not("phone", "is", null)
      .limit(5000);
    matchedContactId = findMatchingContactId(data ?? [], phone, null);
  }
  if (!matchedContactId && email) {
    const { data } = await supabase
      .from("contacts")
      .select("id, phone, email")
      .not("email", "is", null)
      .limit(5000);
    matchedContactId = findMatchingContactId(data ?? [], null, email);
  }

  const { data: rpcData, error } = await supabase
    .rpc("create_customer_directly", {
      p_matched_contact_id: matchedContactId,
      p_full_name: fullName,
      p_phone: phone,
      p_email: email,
      p_instagram_username: instagramUsername,
      p_service_type: serviceType,
      p_custom_service_name: serviceType === "OTHER" ? customServiceName : null,
      p_purchase_notes: purchaseNotes,
      p_agreed_price_amount: agreedPriceAmount,
      p_recurrence: "ONE_TIME",
      p_start_date: startDate,
      p_payment_amount: paymentAmount,
      p_payment_paid_at: paymentPaidAt,
      p_payment_method: paymentMethod,
      p_payment_notes: paymentNotes,
    })
    .single();

  if (error || !rpcData) {
    return {
      error: `לא הצלחנו ליצור את הלקוחה: ${error?.message ?? "שגיאה לא ידועה"}`,
    };
  }

  // Hand-written, not codegen — matches lib/crm/types.ts's own
  // convention for this project (no generated Database type exists),
  // needed since a plain .rpc() call for an RPC not in that
  // hand-written surface is typed loosely.
  const result = rpcData as { customer_id: string };

  revalidatePath("/customers");
  revalidatePath("/dashboard");
  revalidatePath("/payments");

  redirect(`/customers/${result.customer_id}?created=1`);
}
