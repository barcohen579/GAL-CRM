// GAL CRM — Zapier -> Facebook Lead Ads ingestion receiver.
//
// Zapier flow this feeds: "Facebook Lead Ads" trigger (New Lead, page
// גל, the campaign's lead form) -> "Webhooks by Zapier" action (POST)
// -> this endpoint. See docs/zapier-facebook-leads.md for the exact
// Zapier action configuration (URL, payload type, Data field mapping,
// headers).
//
// This is a DISTINCT trust boundary from the direct Meta webhook
// (app/api/meta/leadgen-webhook): Zapier cannot compute Meta's
// X-Hub-Signature-256 HMAC (it doesn't have META_APP_SECRET), so
// authentication here is a shared bearer secret
// (ZAPIER_LEAD_WEBHOOK_SECRET) that Zapier sends back as a static
// "Authorization: Bearer <secret>" header — see lib/meta/zapier-auth.ts.
//
// Everything below reuses the SAME ingestion pipeline as the direct
// Meta webhook (lib/meta/ingest.ts's matchAndCreateCrmEntities, the
// shared MetaIngestionRepo, the same meta_lead_ingestions/touchpoints
// idempotency guarantees) via lib/meta/zapier-ingest.ts — see that
// file's header comment for exactly what is/isn't duplicated.
//
// Order of operations, deliberately: (1) verify auth, (2) parse +
// validate the body, (3) only THEN touch Supabase. A bad secret or a
// malformed/incomplete payload never reaches the database, and never
// requires Supabase env vars to be configured to test locally.
import { createAdminClient } from "../../../../lib/supabase/admin.ts";
import { getZapierLeadWebhookSecret } from "../../../../lib/meta/env.ts";
import { verifyZapierAuthHeader } from "../../../../lib/meta/zapier-auth.ts";
import { parseZapierLeadPayload } from "../../../../lib/meta/zapier-payload.ts";
import { createSupabaseMetaIngestionRepo } from "../../../../lib/meta/repo.ts";
import { processZapierLead } from "../../../../lib/meta/zapier-ingest.ts";
import { getEmailProvider } from "../../../../lib/notifications/get-email-provider.ts";
import { getAppBaseUrl, getGalNotificationEmail } from "../../../../lib/notifications/env.ts";
import { buildWhatsAppUrl } from "../../../../lib/notifications/reminder-logic.ts";
import {
  shouldSendNewLeadNotification,
  sendNewLeadNotification,
} from "../../../../lib/notifications/new-lead-notification.ts";

// node:crypto (used by zapier-auth.ts) requires the Node runtime, not
// the Edge runtime.
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let expectedSecret: string;
  try {
    expectedSecret = getZapierLeadWebhookSecret();
  } catch {
    // Missing server config — fail closed. Never log the (absent) secret.
    return Response.json(
      { success: false, error: "Zapier lead receiving is not configured." },
      { status: 500 }
    );
  }

  const authHeader = request.headers.get("authorization");
  if (!verifyZapierAuthHeader(authHeader, expectedSecret)) {
    return Response.json({ success: false, error: "Unauthorized." }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = parseZapierLeadPayload(rawBody);
  if (!parsed.ok) {
    return Response.json(
      { success: false, error: "Validation failed.", details: parsed.errors },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();
  const repo = createSupabaseMetaIngestionRepo(supabase);
  const receivedAt = new Date().toISOString();

  const outcome = await processZapierLead(repo, parsed.value, receivedAt);

  // Only ids and outcome labels — never fullName/phone/email. Mirrors
  // app/api/meta/leadgen-webhook/route.ts's own logging convention.
  console.log(
    JSON.stringify({
      step: "zapier_facebook_lead_processed",
      facebookLeadId: parsed.value.facebookLeadId,
      outcome: outcome.outcome,
    })
  );

  // Immediate new-lead email — fired at most once, only for a
  // genuinely first-time-processed lead (see
  // shouldSendNewLeadNotification's own doc comment for why this can
  // never fire twice for a retried/duplicated facebookLeadId). Awaited
  // so a config/logging issue is visible in this request's own logs,
  // but sendNewLeadNotification itself never throws and never affects
  // the response below — the lead is already durably persisted by this
  // point regardless of what happens to the email. This is entirely
  // separate from, and does not replace, the next-day AUTOMATIC
  // follow-up escalation (app/api/cron/follow-up-notifications).
  if (shouldSendNewLeadNotification(outcome)) {
    try {
      const appBaseUrl = getAppBaseUrl();
      const recipient = getGalNotificationEmail();
      await sendNewLeadNotification({
        provider: getEmailProvider(),
        recipient,
        lead: {
          fullName: parsed.value.fullName,
          phone: parsed.value.phone,
          email: parsed.value.email,
          source: parsed.value.source ?? "Meta / Facebook Lead Ads (via Zapier)",
          receivedAtIso: parsed.value.occurredAt ?? receivedAt,
          campaignName: parsed.value.campaignName,
          formName: parsed.value.formName,
          adName: parsed.value.adName,
          recordUrl: `${appBaseUrl}/leads/${outcome.leadId}`,
          whatsappUrl: buildWhatsAppUrl(parsed.value.phone),
        },
        recordNotification: async (result) => {
          // This is always the row's FIRST notification attempt (a
          // fresh meta_lead_ingestions row starts notification_attempt_count
          // at 0 — see the migration) — no concurrency risk, so no CAS
          // claim is needed here, unlike processNewLeadNotificationRetries'
          // own retry claim (app/api/cron/follow-up-notifications).
          await supabase
            .from("meta_lead_ingestions")
            .update(
              result.status === "SENT"
                ? { notification_sent_at: result.sentAt, notification_error: null, notification_attempt_count: 1 }
                : { notification_error: result.error, notification_attempt_count: 1 }
            )
            .eq("id", outcome.ingestionId);
        },
      });
    } catch (err) {
      // Only a missing APP_BASE_URL/GAL_NOTIFICATION_EMAIL config can
      // reach here (sendNewLeadNotification itself never throws) — log
      // and move on; the lead is unaffected.
      const message = err instanceof Error ? err.message : "Notification config missing";
      console.error(JSON.stringify({ step: "zapier_new_lead_notification_config_error", message }));
    }
  }

  switch (outcome.outcome) {
    case "processed":
      return Response.json(
        {
          success: true,
          outcome: "processed",
          leadId: outcome.leadId,
          contactId: outcome.contactId,
          touchpointId: outcome.touchpointId,
        },
        { status: 201 }
      );
    case "duplicate":
      // Not an error from Zapier's perspective — the lead already
      // exists in the CRM (same facebookLeadId seen before). A 2xx
      // here matters: it tells Zapier this Zap run succeeded, so it
      // never retries or flags the run as failed.
      return Response.json(
        {
          success: true,
          outcome: "duplicate",
          leadId: outcome.leadId,
          contactId: outcome.contactId,
          touchpointId: outcome.touchpointId,
        },
        { status: 200 }
      );
    case "in_progress_elsewhere":
      // Another delivery for the same facebookLeadId is already being
      // processed concurrently (rare — see lib/meta/repo.ts's
      // claimForProcessing). Report success so Zapier doesn't retry;
      // the in-flight request will finish it.
      return Response.json({ success: true, outcome: "in_progress" }, { status: 200 });
    case "failed":
      return Response.json(
        {
          success: false,
          error: "Processing failed. This delivery is safely retryable (dedup is by facebookLeadId).",
        },
        { status: 500 }
      );
  }
}
