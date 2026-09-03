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

// ============================================================
// Add a Purchase to an existing Customer ("הוספת שירות")
// ============================================================

export type AddPurchaseState = { error: string | null; success?: boolean };

// A Customer may use more than one service at once (e.g. Group
// Training AND Nutrition Coaching, each with its own price and
// payment history) — this adds a second (or third, ...) Purchase to
// an EXISTING Customer. Deliberately does NOT create another Contact,
// Customer, Lead, or Touchpoint — the customer_id is already known,
// there is nothing to match or find-or-create.
//
// Not wrapped in an RPC/transaction, unlike create_customer_directly:
// inspected and decided this doesn't need one. Every intermediate
// state here is already independently valid under the schema — "a
// Purchase with no Payment yet" is an explicitly supported, normal
// state (not partial garbage), exactly like the existing
// recordPayment action's own append-only-ledger design and
// createLead's own "contact saved, lead insert best-effort" precedent
// in this same file. If the Purchase insert succeeds but the Payment
// insert then fails, the customer still has a fully valid new service
// on her profile — Gal just retries the payment via the existing
// "רישום תשלום" action, exactly as she would for any other purchase
// that doesn't have a payment recorded yet.
export async function addPurchase(
  _prevState: AddPurchaseState,
  formData: FormData
): Promise<AddPurchaseState> {
  const customerId = optionalString(formData.get("customer_id"));
  if (!customerId) return { error: "שגיאה פנימית: הלקוחה לא זוהתה." };

  const serviceType = optionalString(formData.get("service_type"));
  if (!serviceType) return { error: "יש לבחור שירות." };
  const customServiceName = optionalString(formData.get("custom_service_name"));
  if (serviceType === "OTHER" && !customServiceName) {
    return { error: 'כשבוחרים "אחר" יש לפרט את שם השירות.' };
  }
  const purchaseNotes = optionalString(formData.get("purchase_notes"));

  const priceRaw = optionalString(formData.get("agreed_price"));
  if (!priceRaw) return { error: "יש להזין מחיר מוסכם." };
  const priceNis = Number(priceRaw.replace(/,/g, ""));
  if (!Number.isFinite(priceNis) || priceNis < 0) {
    return { error: "המחיר שהוזן אינו תקין." };
  }
  // ₪ -> integer agorot. Never store money as a float.
  const agreedPriceAmount = Math.round(priceNis * 100);

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

  // Same default as create_customer_directly: the payment's date when
  // one is given, otherwise today — not asked as a separate field.
  const startDate = paymentPaidAt ?? todayIso();

  const supabase = await createClient();

  const { data: purchase, error: purchaseError } = await supabase
    .from("purchases")
    .insert({
      customer_id: customerId,
      lead_id: null,
      service_type: serviceType,
      custom_service_name: serviceType === "OTHER" ? customServiceName : null,
      agreed_price_amount: agreedPriceAmount,
      agreed_price_currency: "ILS",
      recurrence: "ONE_TIME",
      start_date: startDate,
      status: "ACTIVE",
      notes: purchaseNotes,
    })
    .select("id")
    .single();

  if (purchaseError || !purchase) {
    return {
      error: `לא הצלחנו להוסיף את השירות: ${purchaseError?.message ?? "שגיאה לא ידועה"}`,
    };
  }

  if (paymentAmount !== null) {
    const { error: paymentError } = await supabase.from("payments").insert({
      purchase_id: purchase.id,
      amount: paymentAmount,
      currency: "ILS",
      paid_at: paymentPaidAt,
      method: paymentMethod,
      status: "PAID",
      notes: paymentNotes,
    });
    if (paymentError) {
      return {
        error: `השירות נוסף, אך לא הצלחנו לשמור את התשלום: ${paymentError.message}. אפשר לנסות שוב דרך "רישום תשלום".`,
      };
    }
  }

  revalidatePath(`/customers/${customerId}`);
  revalidatePath("/customers");
  revalidatePath("/dashboard");
  revalidatePath("/payments");

  return { error: null, success: true };
}
