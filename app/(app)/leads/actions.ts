"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { classifyDeleteLeadError } from "@/lib/crm/delete-lead";
import {
  LEAD_LOST_REASONS,
  isLeadConversationOutcome,
  type LeadStage,
} from "@/lib/crm/constants";
import { zonedWallTimeToUtcIso, ISRAEL_TIME_ZONE } from "@/lib/crm/timezone";

function optionalString(value: FormDataEntryValue | null): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > 0 ? s : null;
}

// ============================================================
// Manual lead creation
// ============================================================

// Values echoed back when a possible duplicate is found, so the dialog
// can re-submit them unchanged with an explicit "create anyway"
// (React resets uncontrolled form fields after every action).
export type CreateLeadValues = {
  full_name: string;
  phone: string | null;
  email: string | null;
  instagram_username: string | null;
  interested_services: string[];
  channel: string | null;
  referrer_customer_id: string | null;
  notes: string | null;
};

export type CreateLeadState = {
  error: string | null;
  success?: boolean;
  duplicate?: {
    contactName: string;
    leadId: string | null;
    values: CreateLeadValues;
  };
};

// Creates the contact, lead, interested services, primary touchpoint and
// referral in ONE transaction via create_lead_manually (V2 — previously
// several separate inserts that could leave an orphan contact behind).
// Unless the form explicitly confirms (allow_duplicate=1), an existing
// contact with the same normalized phone or email is reported back as a
// warning and nothing is created — never an automatic merge. The DB
// trigger gives the new lead its one AUTOMATIC new-lead reminder.
export async function createLead(
  _prevState: CreateLeadState,
  formData: FormData
): Promise<CreateLeadState> {
  const fullName = optionalString(formData.get("full_name"));
  if (!fullName) {
    return { error: "יש להזין שם מלא." };
  }

  const values: CreateLeadValues = {
    full_name: fullName,
    phone: optionalString(formData.get("phone")),
    email: optionalString(formData.get("email")),
    instagram_username: optionalString(formData.get("instagram_username")),
    interested_services: formData
      .getAll("interested_services")
      .filter((v): v is string => typeof v === "string" && v.length > 0),
    channel: optionalString(formData.get("channel")),
    referrer_customer_id: optionalString(formData.get("referrer_customer_id")),
    notes: optionalString(formData.get("notes")),
  };
  const allowDuplicate = formData.get("allow_duplicate") === "1";

  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("create_lead_manually", {
      p_full_name: values.full_name,
      p_phone: values.phone,
      p_email: values.email,
      p_instagram_username: values.instagram_username,
      p_notes: values.notes,
      p_interested_services: values.interested_services,
      p_channel: values.channel,
      p_referrer_customer_id: values.channel === "REFERRAL" ? values.referrer_customer_id : null,
      p_allow_duplicate: allowDuplicate,
    })
    .single();

  if (error || !data) {
    return { error: `לא הצלחנו ליצור את הליד: ${error?.message ?? "שגיאה לא ידועה"}` };
  }

  const row = data as {
    lead_id: string | null;
    duplicate_contact_id: string | null;
    duplicate_contact_name: string | null;
    duplicate_lead_id: string | null;
  };

  if (!row.lead_id && row.duplicate_contact_id) {
    return {
      error: null,
      duplicate: {
        contactName: row.duplicate_contact_name ?? "איש קשר קיים",
        leadId: row.duplicate_lead_id,
        values,
      },
    };
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

function stageErrorMessage(error: { code?: string; message: string }): string {
  switch (error.code) {
    case "GALL1":
      return "יש לבחור סיבה.";
    case "GALL2":
      return 'כשבוחרים "סיבה אחרת" יש לכתוב הסבר.';
    case "GALW1":
      return "ליד שנסגר (נסגרה) לא ניתן להחזיר לשלב אחר.";
    default:
      return `לא הצלחנו לעדכן את השלב: ${error.message}`;
  }
}

// Moves a lead to any stage except WON (convert_lead_to_won). The DB
// function is atomic, rejects leaving WON, requires a reason for LOST
// (and a written explanation for "סיבה אחרת"), and closes the lead's
// pending AUTOMATIC new-lead task once it moves past NEW.
export async function changeLeadStage(
  leadId: string,
  newStage: string,
  lostReason?: string | null,
  lostReasonNote?: string | null
): Promise<ChangeStageResult> {
  const note = lostReasonNote?.trim() ? lostReasonNote.trim() : null;
  if (newStage === "LOST") {
    if (!lostReason || !(LEAD_LOST_REASONS as readonly string[]).includes(lostReason)) {
      return { error: "יש לבחור סיבה." };
    }
    if (lostReason === "OTHER" && !note) {
      return { error: 'כשבוחרים "סיבה אחרת" יש לכתוב הסבר.' };
    }
  }

  const supabase = await createClient();

  const { error } = await supabase.rpc("change_lead_stage", {
    p_lead_id: leadId,
    p_new_stage: newStage,
    p_lost_reason: newStage === "LOST" ? lostReason : null,
    p_lost_reason_note: newStage === "LOST" ? note : null,
  });

  if (error) {
    return { error: stageErrorMessage(error) };
  }

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/dashboard");
  revalidatePath("/follow-ups");

  return { error: null };
}

// ============================================================
// Conversation updates
// ============================================================

export type RecordConversationInput = {
  leadId: string;
  outcome: string;
  note: string | null;
  /** Requested stage after the call, or null to keep the current one.
   *  Ignored by the DB for "לא ענתה" (never marks the lead contacted). */
  newStage: LeadStage | null;
  /** Only when Gal explicitly chose to create a follow-up. */
  followUp: { title: string; date: string; time: string; notes: string | null } | null;
};

const CONVERSATION_STAGES: readonly string[] = [
  "NEW",
  "CONTACTED",
  "INTERESTED",
  "TRIAL_BOOKED",
  "TRIAL_COMPLETED",
];

// Records one conversation update in a single transaction
// (record_lead_conversation): the append-only history row, the optional
// stage change and the optional MANUAL follow-up (which supersedes the
// previous pending manual follow-up and closes the AUTOMATIC one).
export async function recordConversation(
  input: RecordConversationInput
): Promise<{ error: string | null }> {
  if (!isLeadConversationOutcome(input.outcome)) {
    return { error: "יש לבחור איך הסתיימה השיחה." };
  }
  const note = input.note?.trim() ? input.note.trim() : null;
  if (input.outcome === "OTHER" && !note) {
    return { error: 'כשבוחרים "אחר" יש לכתוב הערה.' };
  }
  if (input.newStage && !CONVERSATION_STAGES.includes(input.newStage)) {
    return { error: "שלב לא תקין לעדכון שיחה." };
  }

  let followUpDueAt: string | null = null;
  let followUpTitle: string | null = null;
  if (input.followUp) {
    if (!input.followUp.date || !input.followUp.time) {
      return { error: "יש לבחור תאריך ושעה למעקב." };
    }
    try {
      followUpDueAt = zonedWallTimeToUtcIso(input.followUp.date, input.followUp.time, ISRAEL_TIME_ZONE);
    } catch {
      return { error: "התאריך או השעה שהוזנו אינם תקינים." };
    }
    if (Number.isNaN(new Date(followUpDueAt).getTime())) {
      return { error: "התאריך או השעה שהוזנו אינם תקינים." };
    }
    followUpTitle = input.followUp.title.trim() || "שיחת המשך";
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("record_lead_conversation", {
    p_lead_id: input.leadId,
    p_outcome: input.outcome,
    p_note: note,
    p_new_stage: input.newStage,
    p_follow_up_title: followUpTitle,
    p_follow_up_due_at: followUpDueAt,
    p_follow_up_notes: input.followUp?.notes?.trim() || null,
  });

  if (error) {
    return { error: `לא הצלחנו לשמור את עדכון השיחה: ${error.message}` };
  }

  revalidatePath("/leads");
  revalidatePath(`/leads/${input.leadId}`);
  revalidatePath("/dashboard");
  revalidatePath("/follow-ups");

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
  const agreedPriceAmount = Math.round(priceNis * 100);

  if (!startDate) return { error: "יש לבחור תאריך התחלה." };

  const supabase = await createClient();

  // Atomic (convert_lead_to_won): stage + history, cancels pending
  // follow-ups, finds-or-creates the customer, creates the purchase.
  // Refuses a lead that already has a purchase (no duplicate on re-WON).
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

  if (error?.code === "GALW2") {
    return { error: "לליד הזה כבר קיימת רכישה — לא נוצרה רכישה כפולה." };
  }
  if (error || !rpcData) {
    return { error: `לא הצלחנו לסגור את הליד: ${error?.message ?? "שגיאה לא ידועה"}` };
  }

  const { customer_id: customerId } = rpcData as { customer_id: string; purchase_id: string };

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/dashboard");
  revalidatePath("/customers");
  revalidatePath("/payments");

  redirect(`/customers/${customerId}?converted=1`);
}

// ============================================================
// Delete
// ============================================================

export type DeleteLeadState = { error: string | null };

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
