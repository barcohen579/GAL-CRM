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
  const interestedService = optionalString(formData.get("interested_service"));
  const channel = optionalString(formData.get("channel"));
  const notes = optionalString(formData.get("notes"));
  const followUpAt = optionalString(formData.get("follow_up_at"));

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
      interested_service: interestedService,
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

  // Both of the following are best-effort: the lead itself already
  // exists at this point, so a failure here is logged, not fatal to the
  // whole submission.
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

  if (followUpAt) {
    const dueAtIso = new Date(followUpAt).toISOString();
    const { error: taskError } = await supabase.from("follow_up_tasks").insert({
      lead_id: lead.id,
      title: `מעקב מול ${fullName}`,
      due_at: dueAtIso,
      source: "MANUAL",
    });
    if (taskError) {
      console.error("createLead: follow-up task insert failed:", taskError.message);
    }
  }

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

export type ConvertToWonState = {
  error: string | null;
  success?: boolean;
};

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

  const { error } = await supabase.rpc("convert_lead_to_won", {
    p_lead_id: leadId,
    p_service_type: serviceType,
    p_custom_service_name: serviceType === "OTHER" ? customServiceName : null,
    p_agreed_price_amount: agreedPriceAmount,
    p_recurrence: recurrence,
    p_start_date: startDate,
    p_notes: notes,
  });

  if (error) {
    return { error: `לא הצלחנו לסגור את הליד: ${error.message}` };
  }

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/dashboard");
  revalidatePath("/customers");
  revalidatePath("/payments");

  return { error: null, success: true };
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
