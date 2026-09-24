// GAL CRM — Lead Workflow V2 follow-up reminder scheduler.
//
// Triggered by Vercel Cron (vercel.json). The ONLY job is
// processFollowUpReminders (lib/notifications/reminder-job.ts): send the
// single reminder each follow_up_tasks row is entitled to —
//   - "תזכורת לליד חדש — {name}" for a new lead's AUTOMATIC task, and
//   - "מעקב שטרם הושלם — {name}" for a MANUAL follow-up still open after
//     its due date —
// at/after 10:00 Asia/Jerusalem on an eligible business day (Sun-Thu).
//
// Retired in V2 (their tables are kept as read-only history):
//   - the repeating daily AUTOMATIC escalation (lead_auto_escalation_deliveries)
//   - the daily digest (daily_digest_deliveries)
//   - the immediate Meta new-lead email and its retry job
//     (meta_lead_ingestions.notification_*)
// Nothing in this codebase reads those ledgers to send anything anymore,
// so no historical notification can be re-sent from them.
//
// Security: same CRON_SECRET bearer check as the other cron routes
// (lib/cron/auth.ts), fails closed. Uses the service_role admin client.
import { createAdminClient } from "../../../../lib/supabase/admin.ts";
import { getCronSecret } from "../../../../lib/cron/env.ts";
import { verifyCronAuthHeader } from "../../../../lib/cron/auth.ts";
import { getEmailProvider } from "../../../../lib/notifications/get-email-provider.ts";
import { getAppBaseUrl, getGalNotificationEmail } from "../../../../lib/notifications/env.ts";
import { processFollowUpReminders } from "../../../../lib/notifications/reminder-job.ts";
import { createSupabaseReminderRepo } from "../../../../lib/notifications/reminder-repo.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  let expectedSecret: string;
  try {
    expectedSecret = getCronSecret();
  } catch {
    return new Response("Scheduled follow-up notifications are not configured.", { status: 500 });
  }

  const authHeader = request.headers.get("authorization");
  if (!verifyCronAuthHeader(authHeader, expectedSecret)) {
    return new Response("Unauthorized.", { status: 401 });
  }

  let appBaseUrl: string;
  let recipient: string;
  try {
    appBaseUrl = getAppBaseUrl();
    recipient = getGalNotificationEmail();
  } catch (err) {
    // Configuration problem: claim nothing, so no retry budget is burned.
    const message = err instanceof Error ? err.message : "Notification config missing";
    console.error(JSON.stringify({ step: "follow_up_reminders_config_error", message }));
    return Response.json({ ok: false, error: "configuration" }, { status: 500 });
  }

  try {
    const reminders = await processFollowUpReminders({
      repo: createSupabaseReminderRepo(createAdminClient()),
      provider: getEmailProvider(),
      recipient,
      appBaseUrl,
    });
    // Only counts — never a contact name, note, or email address.
    console.log(JSON.stringify({ step: "follow_up_reminders_completed", reminders }));
    return Response.json({ ok: true, reminders });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(JSON.stringify({ step: "follow_up_reminders_failed", message }));
    return Response.json({ ok: false, error: "reminder job failed" }, { status: 500 });
  }
}
