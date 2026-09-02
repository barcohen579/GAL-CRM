"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

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

  const dueAt = new Date(`${date}T${time}`);
  if (Number.isNaN(dueAt.getTime())) {
    return { error: "התאריך או השעה שהוזנו אינם תקינים." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("follow_up_tasks").insert({
    lead_id: leadId,
    customer_id: customerId,
    title,
    notes,
    due_at: dueAt.toISOString(),
    status: "PENDING",
    source: "MANUAL",
  });

  if (error) {
    return { error: `לא הצלחנו לשמור את המעקב: ${error.message}` };
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
