"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { findMatchingContactId } from "@/lib/crm/contact-matching";
import { firstOfMonth, addCalendarMonths } from "@/lib/crm/recurring";

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

  // "מקור הגעה" — for this direct (leadless) flow, only meaningfully
  // persisted when it's REFERRAL: touchpoints.lead_id is NOT NULL in
  // this schema (every touchpoint belongs to a Lead), and this
  // customer deliberately has none, so there is nowhere to store any
  // OTHER channel value without either inventing a fake Lead (which
  // this whole flow exists to avoid) or a broader touchpoints schema
  // change unrelated to what this feature actually needs. The
  // selector still offers the full channel vocabulary (for
  // consistency with Add Lead), but only source === "REFERRAL" has a
  // stored effect right now — see public.referrals.
  const source = optionalString(formData.get("source"));
  const referrerCustomerId =
    source === "REFERRAL" ? optionalString(formData.get("referrer_customer_id")) : null;

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
  // ₪ -> integer agorot. Never store money as a float. For a recurring
  // purchase, this doubles as "the current monthly amount" — see
  // supabase/migrations/20260903150000_..._recurring_billing_schema.sql
  // for why there's no separate recurring-amount column.
  const agreedPriceAmount = Math.round(priceNis * 100);

  // "סוג תשלום" — recurrence is explicit, never inferred from
  // service_type (a Group Training could be either a one-time trial or
  // an ongoing monthly membership; only the user knows which this is).
  const recurrence =
    optionalString(formData.get("recurrence")) === "RECURRING_MONTHLY"
      ? "RECURRING_MONTHLY"
      : "ONE_TIME";

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

  // next_billing_date (recurring only): if a first payment is being
  // recorded right now, that payment covers ITS OWN month (the RPC
  // sets its billing_cycle to match — see the migration), so the next
  // AUTO-generated cycle is the month after it. Otherwise nothing has
  // been paid for the very first cycle yet — it starts owing from
  // start_date's own month, so the scheduled job picks it up whenever
  // that month has begun. Either way this is a plain first-of-month
  // date computed once here, never a separate form field (per the
  // "keep this extremely simple" requirement).
  const nextBillingDate =
    recurrence === "RECURRING_MONTHLY"
      ? paymentPaidAt
        ? addCalendarMonths(firstOfMonth(paymentPaidAt), 1)
        : firstOfMonth(startDate)
      : null;

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
      p_recurrence: recurrence,
      p_start_date: startDate,
      p_payment_amount: paymentAmount,
      p_payment_paid_at: paymentPaidAt,
      p_payment_method: paymentMethod,
      p_payment_notes: paymentNotes,
      p_referrer_customer_id: referrerCustomerId,
      p_next_billing_date: nextBillingDate,
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
  // ₪ -> integer agorot. Never store money as a float. For a recurring
  // purchase, this doubles as "the current monthly amount".
  const agreedPriceAmount = Math.round(priceNis * 100);

  // "סוג תשלום" — see the identical comment in createCustomerDirectly
  // above for why this is always explicit, never inferred.
  const recurrence =
    optionalString(formData.get("recurrence")) === "RECURRING_MONTHLY"
      ? "RECURRING_MONTHLY"
      : "ONE_TIME";

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

  // Same next_billing_date reasoning as createCustomerDirectly above —
  // an immediate first payment covers its own month (billing_cycle set
  // below), so the next auto cycle starts the month after it;
  // otherwise the first cycle itself is still owed, starting from
  // start_date's month.
  const nextBillingDate =
    recurrence === "RECURRING_MONTHLY"
      ? paymentPaidAt
        ? addCalendarMonths(firstOfMonth(paymentPaidAt), 1)
        : firstOfMonth(startDate)
      : null;

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
      recurrence,
      start_date: startDate,
      status: "ACTIVE",
      notes: purchaseNotes,
      next_billing_date: nextBillingDate,
    })
    .select("id")
    .single();

  if (purchaseError || !purchase) {
    return {
      error: `לא הצלחנו להוסיף את השירות: ${purchaseError?.message ?? "שגיאה לא ידועה"}`,
    };
  }

  if (paymentAmount !== null) {
    // The first cycle payment for a recurring purchase occupies its
    // own billing_cycle slot — see payments_purchase_billing_cycle_key
    // — exactly like create_customer_directly's own first-payment
    // handling, so the scheduled job never re-generates this month.
    const billingCycle =
      recurrence === "RECURRING_MONTHLY" && paymentPaidAt ? firstOfMonth(paymentPaidAt) : null;

    const { error: paymentError } = await supabase.from("payments").insert({
      purchase_id: purchase.id,
      amount: paymentAmount,
      currency: "ILS",
      paid_at: paymentPaidAt,
      method: paymentMethod,
      status: "PAID",
      notes: paymentNotes,
      billing_cycle: billingCycle,
      is_auto_generated: false,
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

// ============================================================
// Monthly recurring billing management
// ("הפעלת/הפסקת/עדכון מחיר של חיוב חודשי")
// ============================================================

export type RecurringBillingState = { error: string | null; success?: boolean };

// "הפעלת חיוב חודשי" — turns an EXISTING, currently non-recurring
// ACTIVE Purchase into an ongoing monthly one (works for the very
// first customer this is enabled on, or any later existing Purchase).
// Plain single-row UPDATE, no RPC: purchases already has full CRUD RLS
// for authenticated CRM users, and there is no second table to write
// atomically alongside it. Gal picks the monthly amount and the next
// billing date directly — deliberately NOT inferred from "has this
// month already been paid", which would require guessing at intent;
// asking directly is simpler and unambiguous (see lib/crm/recurring.ts).
export async function enableRecurringBilling(
  _prevState: RecurringBillingState,
  formData: FormData
): Promise<RecurringBillingState> {
  const purchaseId = optionalString(formData.get("purchase_id"));
  const customerId = optionalString(formData.get("customer_id"));
  if (!purchaseId || !customerId) {
    return { error: "שגיאה פנימית: הרכישה לא זוהתה." };
  }

  const priceRaw = optionalString(formData.get("monthly_amount"));
  if (!priceRaw) return { error: "יש להזין סכום חודשי." };
  const priceNis = Number(priceRaw.replace(/,/g, ""));
  if (!Number.isFinite(priceNis) || priceNis < 0) {
    return { error: "הסכום שהוזן אינו תקין." };
  }
  // ₪ -> integer agorot. Never store money as a float.
  const monthlyAmount = Math.round(priceNis * 100);

  const nextBillingDateInput = optionalString(formData.get("next_billing_date"));
  if (!nextBillingDateInput) return { error: "יש לבחור תאריך לחיוב הבא." };
  const nextBillingDate = firstOfMonth(nextBillingDateInput);

  const supabase = await createClient();
  const { error } = await supabase
    .from("purchases")
    .update({
      recurrence: "RECURRING_MONTHLY",
      status: "ACTIVE",
      agreed_price_amount: monthlyAmount,
      next_billing_date: nextBillingDate,
    })
    .eq("id", purchaseId);

  if (error) {
    return { error: `לא הצלחנו להפעיל חיוב חודשי: ${error.message}` };
  }

  revalidatePath(`/customers/${customerId}`);
  revalidatePath("/customers");

  return { error: null, success: true };
}

// "הפסקת חיוב חודשי" — stops every FUTURE automatic payment. Never
// deletes or edits any existing Purchase/Payment — only the two
// billing-control fields move. recurrence itself is deliberately left
// as RECURRING_MONTHLY (not reset to ONE_TIME): this WAS a monthly
// service, and that history shouldn't disappear just because it
// stopped; status = CANCELLED plus next_billing_date = NULL is what
// actually gates generate_due_recurring_payments() (see its own
// migration), and CANCELLED already renders as the familiar red "בוטל"
// badge everywhere purchase status is shown. Called directly (not a
// useActionState form action) — same pattern as deleteLead, for a
// confirm-dialog button rather than a form.
export async function stopRecurringBilling(
  purchaseId: string,
  customerId: string
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("purchases")
    .update({ status: "CANCELLED", next_billing_date: null })
    .eq("id", purchaseId);

  if (error) {
    return { error: `לא הצלחנו להפסיק את החיוב החודשי: ${error.message}` };
  }

  revalidatePath(`/customers/${customerId}`);
  revalidatePath("/customers");

  return { error: null };
}

export type UpdatePriceState = { error: string | null; success?: boolean };

// "עדכון מחיר חודשי" — changes the amount used starting the NEXT
// un-generated cycle only. Every already-generated payment already
// froze its own amount permanently (payments.amount is immutable —
// prevent_payment_fact_changes), so this can never rewrite a
// historical figure; it only ever updates
// purchases.agreed_price_amount, which generate_due_recurring_payments()
// reads fresh at generation time — no separate price-history table.
export async function updateRecurringPrice(
  _prevState: UpdatePriceState,
  formData: FormData
): Promise<UpdatePriceState> {
  const purchaseId = optionalString(formData.get("purchase_id"));
  const customerId = optionalString(formData.get("customer_id"));
  if (!purchaseId || !customerId) {
    return { error: "שגיאה פנימית: הרכישה לא זוהתה." };
  }

  const priceRaw = optionalString(formData.get("monthly_amount"));
  if (!priceRaw) return { error: "יש להזין סכום חודשי חדש." };
  const priceNis = Number(priceRaw.replace(/,/g, ""));
  if (!Number.isFinite(priceNis) || priceNis < 0) {
    return { error: "הסכום שהוזן אינו תקין." };
  }
  const monthlyAmount = Math.round(priceNis * 100);

  const supabase = await createClient();
  const { error } = await supabase
    .from("purchases")
    .update({ agreed_price_amount: monthlyAmount })
    .eq("id", purchaseId)
    .eq("recurrence", "RECURRING_MONTHLY");

  if (error) {
    return { error: `לא הצלחנו לעדכן את המחיר: ${error.message}` };
  }

  revalidatePath(`/customers/${customerId}`);
  revalidatePath("/customers");

  return { error: null, success: true };
}

// ============================================================
// Edit Customer Details ("עריכת פרטים")
// ============================================================

export type UpdateContactState = { error: string | null; success?: boolean };

// Edits the Contact belonging to this Customer — never creates or
// touches any other row. purchases/payments/recurring config/leads/
// touchpoints/referrals all reference this same Contact/Customer by
// id, never by name or by a copy of phone/email, so nothing else needs
// to change: a referral row's displayed name (e.g. "הופנתה על ידי
// ...") is read fresh via a join at request time (see /customers/[id]
// and /leads/[id]'s own queries) — renaming this contact is
// automatically reflected everywhere the next time those pages render,
// with no update needed here.
export async function updateContactDetails(
  _prevState: UpdateContactState,
  formData: FormData
): Promise<UpdateContactState> {
  const contactId = optionalString(formData.get("contact_id"));
  const customerId = optionalString(formData.get("customer_id"));
  if (!contactId || !customerId) {
    return { error: "שגיאה פנימית: הלקוחה לא זוהתה." };
  }

  const fullName = optionalString(formData.get("full_name"));
  if (!fullName) {
    return { error: "יש להזין שם מלא." };
  }

  // Empty optional fields are stored as NULL, never "" — same
  // convention `optionalString` already enforces everywhere else in
  // this codebase (createLead, createCustomerDirectly, addPurchase, ...).
  const phone = optionalString(formData.get("phone"));
  const email = optionalString(formData.get("email"));
  const instagramUsername = optionalString(formData.get("instagram_username"));

  const supabase = await createClient();

  // Identity-collision protection: the SAME deterministic rule used
  // everywhere else a Contact is matched — normalized phone, then
  // normalized email, NEVER by name (lib/crm/contact-matching.ts,
  // shared with the Meta ingestion pipeline and the Add Customer
  // flow). Excludes THIS contact from the candidate pool — matching
  // its own current phone/email back to itself is not a conflict.
  // Mirrors createCustomerDirectly's own two-query shape exactly.
  let conflict: { id: string; full_name: string } | null = null;
  if (phone) {
    const { data } = await supabase
      .from("contacts")
      .select("id, full_name, phone, email")
      .neq("id", contactId)
      .not("phone", "is", null)
      .limit(5000);
    const matchId = findMatchingContactId(data ?? [], phone, null);
    if (matchId) conflict = (data ?? []).find((c) => c.id === matchId) ?? null;
  }
  if (!conflict && email) {
    const { data } = await supabase
      .from("contacts")
      .select("id, full_name, phone, email")
      .neq("id", contactId)
      .not("email", "is", null)
      .limit(5000);
    const matchId = findMatchingContactId(data ?? [], null, email);
    if (matchId) conflict = (data ?? []).find((c) => c.id === matchId) ?? null;
  }
  if (conflict) {
    return {
      error: `הפרטים שהוזנו כבר שייכים לאיש קשר אחר במערכת (${conflict.full_name}). לא ניתן לשמור שינוי שיוצר כפילות.`,
    };
  }

  const { error } = await supabase
    .from("contacts")
    .update({
      full_name: fullName,
      phone,
      email,
      instagram_username: instagramUsername,
    })
    .eq("id", contactId);

  if (error) {
    return { error: `לא הצלחנו לשמור את השינויים: ${error.message}` };
  }

  // Every page that could display this contact's name (its own
  // /customers/[id], the /customers list, and any /leads/[id] where
  // it's shown as a referrer) is already force-dynamic (no caching),
  // so it re-reads the join fresh on next navigation regardless —
  // revalidatePath here only needs to cover this page itself.
  revalidatePath(`/customers/${customerId}`);
  revalidatePath("/customers");

  return { error: null, success: true };
}
