"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { classifyDeleteLeadError } from "@/lib/crm/delete-lead";

export type CreateLeadState = {
  error: string | null;
  success?: boolean;
};

function optionalString(value: FormDataEntryValue | null): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > 0 ? s : null;
}

export async function createLead(
  _prevState: CreateLeadState,
  formData: FormData
): Promise<CreateLeadState> {
  const fullName = optionalString(formData.get("full_name"));
  if (!fullName) {
    return { error: "יש להזין שם מלא." };
  }

  const phone = optionalString(formData.get("phone"));
  const email = optionalString(formData.get("email"));
  const instagramUsername = optionalString(formData.get("instagram_username"));
  // A lead may be interested in more than one service at once — see
  // public.lead_interested_services. getAll() returns every checked
  // checkbox sharing this field name; an unchecked field is simply
  // absent, never an empty-string entry.
  const interestedServices = formData
    .getAll("interested_services")
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const channel = optionalString(formData.get("channel"));
  const referrerCustomerId = optionalString(formData.get("referrer_customer_id"));
  const notes = optionalString(formData.get("notes"));

  const supabase = await createClient();

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .insert({
      full_name: fullName,
      phone,
      email,
      instagram_username: instagramUsername,
      notes,
    })
    .select("id")
    .single();

  if (contactError || !contact) {
    return {
      error: `לא הצלחנו לשמור את איש הקשר: ${
        contactError?.message ?? "שגיאה לא ידועה"
      }`,
    };
  }

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .insert({
      contact_id: contact.id,
    })
    .select("id")
    .single();

  if (leadError || !lead) {
    // The contact row was created but the lead wasn't — not rolled back
    // automatically (no multi-table transaction here, a known V1
    // limitation). Surface the failure clearly rather than pretending it
    // succeeded.
    return {
      error: `איש הקשר נשמר, אך לא הצלחנו ליצור את הליד: ${
        leadError?.message ?? "שגיאה לא ידועה"
      }. בדקי בעמוד הלידים — ייתכן שיהיה צורך למחוק איש קשר כפול.`,
    };
  }

  // All of the following are best-effort: the lead itself already
  // exists at this point, so a failure here is logged, not fatal to the
  // whole submission.
  if (interestedServices.length > 0) {
    const { error: servicesError } = await supabase
      .from("lead_interested_services")
      .insert(interestedServices.map((s) => ({ lead_id: lead.id, service_type: s })));
    if (servicesError) {
      console.error("createLead: interested services insert failed:", servicesError.message);
    }
  }

  if (channel) {
    const { error: touchpointError } = await supabase
      .from("touchpoints")
      .insert({
        lead_id: lead.id,
        channel,
        certainty: "BROAD",
        is_primary: true,
      });
    if (touchpointError) {
      console.error("createLead: touchpoint insert failed:", touchpointError.message);
    }
  }

  // Referral ("הופנתה על ידי"): recorded against the Contact, not the
  // Lead — see public.referrals and its own migration for why (the
  // relationship must survive WON conversion unchanged, which it does
  // automatically by never referencing lead_id at all). Self-referral
  // is structurally impossible here: createLead always makes a brand
  // new Contact (no matching against existing contacts happens in this
  // flow), so it can never coincide with an existing customer.
  if (channel === "REFERRAL" && referrerCustomerId) {
    const { error: referralError } = await supabase
      .from("referrals")
      .insert({ referred_contact_id: contact.id, referrer_customer_id: referrerCustomerId });
    if (referralError) {
      console.error("createLead: referral insert failed:", referralError.message);
    }
  }

  // No manual follow-up is created here. Every new lead already gets its
  // Day-0 AUTOMATIC follow-up from the create_automatic_followup_for_new_lead()
  // DB trigger (see supabase/migrations/..._automatic_lead_followup_escalation.sql).
  // This action used to also accept an optional follow-up date/time and
  // create a second, MANUAL follow-up from it — removed as an approved
  // product cleanup: it predated the automatic loop and, now that every
  // lead gets one anyway, only produced a redundant MANUAL row that
  // permanently suppressed the automatic one from the actionable UI (see
  // lib/crm/follow-up-visibility.ts) for no benefit. A specific follow-up
  // date/time is still available any time via "מעקב חדש" on the lead's
  // own detail page (createFollowUp in app/(app)/follow-ups/actions.ts).

  revalidatePath("/leads");
  revalidatePath("/dashboard");
  revalidatePath("/follow-ups");

  return { error: null, success: true };
}

// ============================================================
// Stage changes
// ============================================================

export type ChangeStageResult = { error: string | null };

// Moves a lead to any stage except WON (the DB function itself rejects
// WON — see supabase/migrations/..._lead_workflow_functions.sql). The
// function is atomic (stage update + lead_stage_events insert in one
// transaction) and no-ops cleanly when the stage is unchanged, so this
// is safe to call even if the UI ends up invoking it redundantly.
export async function changeLeadStage(
  leadId: string,
  newStage: string,
  lostReason?: string | null
): Promise<ChangeStageResult> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("change_lead_stage", {
    p_lead_id: leadId,
    p_new_stage: newStage,
    p_lost_reason: lostReason ?? null,
  });

  if (error) {
    return { error: `לא הצלחנו לעדכן את השלב: ${error.message}` };
  }

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/dashboard");

  return { error: null };
}

// ============================================================
// WON conversion
// ============================================================

export type ConvertToWonState = { error: string | null };

export async function convertLeadToWon(
  _prevState: ConvertToWonState,
  formData: FormData
): Promise<ConvertToWonState> {
  const leadId = optionalString(formData.get("lead_id"));
  const serviceType = optionalString(formData.get("service_type"));
  const customServiceName = optionalString(formData.get("custom_service_name"));
  const priceRaw = optionalString(formData.get("agreed_price"));
  const recurrence = optionalString(formData.get("recurrence")) ?? "ONE_TIME";
  const startDate = optionalString(formData.get("start_date"));
  const notes = optionalString(formData.get("notes"));

  if (!leadId) return { error: "שגיאה פנימית: הליד לא זוהה." };
  if (!serviceType) return { error: "יש לבחור שירות." };
  if (serviceType === "OTHER" && !customServiceName) {
    return { error: 'כשבוחרים "אחר" יש לפרט את שם השירות.' };
  }
  if (!priceRaw) return { error: "יש להזין מחיר מוסכם." };

  const priceNis = Number(priceRaw.replace(/,/g, ""));
  if (!Number.isFinite(priceNis) || priceNis < 0) {
    return { error: "המחיר שהוזן אינו תקין." };
  }
  // ₪ -> integer agorot. Never store money as a float.
  const agreedPriceAmount = Math.round(priceNis * 100);

  if (!startDate) return { error: "יש לבחור תאריך התחלה." };

  const supabase = await createClient();

  const { data: rpcData, error } = await supabase
    .rpc("convert_lead_to_won", {
      p_lead_id: leadId,
      p_service_type: serviceType,
      p_custom_service_name: serviceType === "OTHER" ? customServiceName : null,
      p_agreed_price_amount: agreedPriceAmount,
      p_recurrence: recurrence,
      p_start_date: startDate,
      p_notes: notes,
    })
    .single();

  if (error || !rpcData) {
    return { error: `לא הצלחנו לסגור את הליד: ${error?.message ?? "שגיאה לא ידועה"}` };
  }

  // Hand-written, not codegen — same convention as
  // app/(app)/customers/actions.ts for an RPC result outside
  // lib/crm/types.ts's small hand-written surface.
  const { customer_id: customerId } = rpcData as { customer_id: string; purchase_id: string };

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/dashboard");
  revalidatePath("/customers");
  revalidatePath("/payments");

  // Converting records ONE purchased service — a lead interested in
  // several services is NOT assumed to have bought all of them (see
  // WonConversionDialog's own interested-services context note). If
  // there's more to record, /customers/[id]'s "הוספת שירות" action is
  // the natural next step — landing there directly makes that handoff
  // smooth rather than leaving Gal to navigate there herself.
  redirect(`/customers/${customerId}?converted=1`);
}

// ============================================================
// Deletion
// ============================================================

export type DeleteLeadState = { error: string | null };

// Permanently deletes a lead via the atomic, safety-gated
// delete_lead_safely() RPC (all-or-nothing — see that function's own
// comments for exactly what it does and does not delete). On success,
// redirects to /leads?deleted=1 rather than returning normally, so the
// caller never needs its own "now navigate away" branch. Error ->
// Hebrew-message mapping lives in lib/crm/delete-lead.ts (extracted
// so it's unit-testable — a "use server" file may only export async
// Server Actions).
export async function deleteLead(
  leadId: string
): Promise<DeleteLeadState> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("delete_lead_safely", {
    p_lead_id: leadId,
  });

  const message = classifyDeleteLeadError(error);
  if (message) {
    return { error: message };
  }

  revalidatePath("/leads");
  revalidatePath("/dashboard");
  redirect("/leads?deleted=1");
}
