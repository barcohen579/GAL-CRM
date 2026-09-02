"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

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
