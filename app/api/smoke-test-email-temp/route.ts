// TEMPORARY — one-time Production email smoke test. See the task this
// was built for: confirm the CURRENT MANUAL follow-up reminder
// template + Resend provider actually deliver, using REAL Production
// data for the ליד בדיקה Lead, without touching any permanent
// business state.
//
// Deliberately narrower than app/api/cron/follow-up-notifications:
//   - Hardcoded to exactly ONE known Lead id (below) — never a query
//     that could pick up an arbitrary/different row on a later run.
//   - READ-ONLY against every follow-up/delivery table: selects the
//     Lead's current PENDING MANUAL follow_up_tasks row and its own
//     contact/interested-services, and does not otherwise write
//     anything to it or to follow_up_reminder_deliveries or
//     lead_auto_escalation_deliveries. No claim, no status change, no
//     delivery ledger row is created — this send is deliberately
//     invisible to the real reminder/escalation/digest systems.
//   - Not registered anywhere in vercel.json — no schedule, ever.
//     Reachable only by an explicit manual call carrying the same
//     CRON_SECRET already used by every other /api/cron/* route (see
//     lib/cron/auth.ts) — no new secret was introduced for this.
//   - This whole file is deleted immediately after the one approved
//     send it exists for; do not resurrect this pattern without a new,
//     equally explicit approval.
import { createAdminClient } from "../../../lib/supabase/admin.ts";
import { getCronSecret } from "../../../lib/cron/env.ts";
import { verifyCronAuthHeader } from "../../../lib/cron/auth.ts";
import { getEmailProvider } from "../../../lib/notifications/get-email-provider.ts";
import { getAppBaseUrl, getGalNotificationEmail } from "../../../lib/notifications/env.ts";
import { buildManualFollowUpReminderEmail } from "../../../lib/notifications/templates.ts";
import { buildWhatsAppUrl } from "../../../lib/notifications/reminder-logic.ts";
import { SERVICE_TYPE_LABELS, type ServiceType } from "../../../lib/crm/constants.ts";

export const runtime = "nodejs";
export const maxDuration = 30;

// ליד בדיקה — the exact Lead this smoke test is for, per the approved
// task. Never derived from a query, so this can never silently target
// a different Lead on a later invocation.
const SMOKE_TEST_LEAD_ID = "bc67a3fa-2223-4dcf-9990-6b550175aa47";

type LeadRow = {
  id: string;
  contact: { full_name: string; phone: string | null } | null;
  interested_services: { service_type: ServiceType }[];
  follow_up_tasks: {
    id: string;
    title: string;
    notes: string | null;
    due_at: string;
    status: string;
    source: string;
  }[];
};

export async function GET(request: Request): Promise<Response> {
  let expectedSecret: string;
  try {
    expectedSecret = getCronSecret();
  } catch {
    return new Response("Smoke test is not configured.", { status: 500 });
  }

  const authHeader = request.headers.get("authorization");
  if (!verifyCronAuthHeader(authHeader, expectedSecret)) {
    return new Response("Unauthorized.", { status: 401 });
  }

  const supabase = createAdminClient();

  // Pure SELECT — no .update()/.insert() anywhere in this route.
  const { data, error } = await supabase
    .from("leads")
    .select(
      `id, contact:contacts(full_name, phone),
       interested_services:lead_interested_services(service_type),
       follow_up_tasks(id, title, notes, due_at, status, source)`
    )
    .eq("id", SMOKE_TEST_LEAD_ID)
    .maybeSingle();

  if (error || !data) {
    return Response.json({ ok: false, step: "lead_query_failed", error: error?.message }, { status: 500 });
  }

  const lead = data as unknown as LeadRow;
  const manualTask = lead.follow_up_tasks.find((t) => t.source === "MANUAL" && t.status === "PENDING");

  if (!manualTask) {
    // Fail closed rather than fabricate content or fall back to a
    // different row — this smoke test exists to prove the REAL current
    // state renders/sends correctly, nothing else.
    return Response.json(
      { ok: false, step: "no_current_pending_manual_follow_up_found" },
      { status: 404 }
    );
  }

  let appBaseUrl: string;
  let recipient: string;
  try {
    appBaseUrl = getAppBaseUrl();
    recipient = getGalNotificationEmail();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Notification config missing";
    return Response.json({ ok: false, step: "config_error", error: message }, { status: 500 });
  }

  const leadName = lead.contact?.full_name ?? "איש קשר";
  const interestedServiceLabels = lead.interested_services.map((s) => SERVICE_TYPE_LABELS[s.service_type]);
  const whatsappUrl = buildWhatsAppUrl(lead.contact?.phone ?? null);

  const email = buildManualFollowUpReminderEmail({
    leadName,
    title: manualTask.title,
    notes: manualTask.notes,
    interestedServiceLabels,
    dueAtIso: manualTask.due_at,
    recordUrl: `${appBaseUrl}/leads/${lead.id}`,
    whatsappUrl,
  });

  const provider = getEmailProvider();
  const result = await provider.send({
    to: recipient,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });

  if (!result.ok) {
    return Response.json({ ok: false, step: "send_failed", error: result.error }, { status: 502 });
  }

  // No DB write follows — this send is deliberately invisible to
  // follow_up_tasks/follow_up_reminder_deliveries/
  // lead_auto_escalation_deliveries. Response carries only what the
  // task's own report needs (ids, subject, provider message id) —
  // never the email body/notes/phone.
  return Response.json({
    ok: true,
    leadId: lead.id,
    followUpTaskId: manualTask.id,
    subject: email.subject,
    providerMessageId: result.providerMessageId,
  });
}
