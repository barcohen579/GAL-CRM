"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { zonedWallTimeToUtcIso, ISRAEL_TIME_ZONE } from "@/lib/crm/timezone";

function optionalString(value: FormDataEntryValue | null): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length > 0 ? s : null;
}

function revalidateFollowUpPaths(leadId?: string | null, customerId?: string | null) {
  revalidatePath("/follow-ups");
  revalidatePath("/dashboard");
  revalidatePath("/leads");
  if (leadId) revalidatePath(`/leads/${leadId}`);
  if (customerId) revalidatePath(`/customers/${customerId}`);
}

// ============================================================
// Create
// ============================================================

export type CreateFollowUpState = { error: string | null; success?: boolean };

export async function createFollowUp(
  _prevState: CreateFollowUpState,
  formData: FormData
): Promise<CreateFollowUpState> {
  const leadId = optionalString(formData.get("lead_id"));
  const customerId = optionalString(formData.get("customer_id"));
  const date = optionalString(formData.get("date"));
  const time = optionalString(formData.get("time"));
  const title = optionalString(formData.get("title"));
  const notes = optionalString(formData.get("notes"));

  if (!leadId && !customerId) {
    return { error: "שגיאה פנימית: לא ידוע למי לשייך את המעקב." };
  }
  if (!title) {
    return { error: "יש לתאר מה צריך לעשות." };
  }
  if (!date || !time) {
    return { error: "יש לבחור תאריך ושעה למעקב." };
  }

  // Gal picks a date+time meaning "10:00 my time" (Asia/Jerusalem) —
  // never the server's own timezone (Vercel serverless functions run
  // in UTC by default). A naive `new Date(`${date}T${time}`)` would
  // silently interpret that as 10:00 UTC (13:00/12:00 Israel time
  // depending on DST) — exactly the bug this must not have. See
  // lib/crm/timezone.ts's own comment for why this needs real IANA tz
  // data, not fixed +2/+3 arithmetic.
  let dueAtIso: string;
  try {
    dueAtIso = zonedWallTimeToUtcIso(date, time, ISRAEL_TIME_ZONE);
  } catch {
    return { error: "התאריך או השעה שהוזנו אינם תקינים." };
  }
  if (Number.isNaN(new Date(dueAtIso).getTime())) {
    return { error: "התאריך או השעה שהוזנו אינם תקינים." };
  }

  const supabase = await createClient();

  if (leadId) {
    // "One current MANUAL follow-up per Lead": create_manual_follow_up_for_lead
    // is the single authoritative, transactional way to create a
    // Lead-linked MANUAL follow-up — it atomically cancels (never
    // deletes) any still-PENDING MANUAL follow-up already on this lead
    // and inserts the new one as the lead's single current PENDING
    // MANUAL row, with a lead-row lock making it safe against a
    // concurrent creation for the same lead. See
    // supabase/migrations/20260904170000_..._one_current_manual_follow_up_rpc.sql.
    // A customer-linked follow-up (below) has no AUTOMATIC fallback to
    // coordinate with, so it keeps the plain insert — this invariant is
    // Lead-specific.
    const { error } = await supabase.rpc("create_manual_follow_up_for_lead", {
      p_lead_id: leadId,
      p_title: title,
      p_notes: notes,
      p_due_at: dueAtIso,
    });
    if (error) {
      return { error: `לא הצלחנו לשמור את המעקב: ${error.message}` };
    }
  } else {
    const { error } = await supabase.from("follow_up_tasks").insert({
      customer_id: customerId,
      title,
      notes,
      due_at: dueAtIso,
      status: "PENDING",
      source: "MANUAL",
    });
    if (error) {
      return { error: `לא הצלחנו לשמור את המעקב: ${error.message}` };
    }
  }

  revalidateFollowUpPaths(leadId, customerId);
  return { error: null, success: true };
}

// ============================================================
// Complete
// ============================================================

export async function completeFollowUp(
  taskId: string,
  note: string | null,
  leadId?: string | null,
  customerId?: string | null
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("follow_up_tasks")
    .update({
      status: "COMPLETED",
      completed_at: new Date().toISOString(),
      completed_note: note,
    })
    .eq("id", taskId);

  if (error) {
    return { error: `לא הצלחנו לסמן את המעקב כהושלם: ${error.message}` };
  }

  revalidateFollowUpPaths(leadId, customerId);
  return { error: null };
}

// ============================================================
// Cancel
// ============================================================

export async function cancelFollowUp(
  taskId: string,
  leadId?: string | null,
  customerId?: string | null
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("follow_up_tasks")
    .update({ status: "CANCELLED" })
    .eq("id", taskId);

  if (error) {
    return { error: `לא הצלחנו לבטל את המעקב: ${error.message}` };
  }

  revalidateFollowUpPaths(leadId, customerId);
  return { error: null };
}
