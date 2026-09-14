// GAL CRM — Meta Lead Ads webhook receiver (Phase 3B).
//
// GET  = Meta's webhook verification handshake (hub.mode / hub.verify_token
//        / hub.challenge). See lib/meta/env.ts for META_WEBHOOK_VERIFY_TOKEN.
// POST = actual lead notification delivery. Every POST payload is
//        treated as UNTRUSTED until its X-Hub-Signature-256 header is
//        verified against META_APP_SECRET — nothing in the body is
//        parsed or acted on before that check passes.
//
// This route does not itself talk to any Meta write endpoint, does not
// subscribe/unsubscribe anything, and — per Phase 3B scope — is not yet
// wired up in the Meta Developer Dashboard (see the Phase 3B report for
// the exact remaining manual steps). It is safe to deploy inert: with
// META_APP_SECRET/META_WEBHOOK_VERIFY_TOKEN unset it fails closed (500,
// no secret ever logged) rather than silently accepting anything.
//
// Processing model: synchronous, one leadgen_id at a time, within this
// request — see the design-decision comment at the top of
// lib/meta/ingest.ts for the full rationale (this is the file to read
// before changing that decision).

// Uses the plain Web Response API (not next/server's NextResponse) —
// nothing here needs NextRequest/NextResponse's extra conveniences
// (cookies, rewritten URLs, ...), and staying on the Web-standard API
// means this route's own handlers can be imported and called directly
// in tests with a real Request, entirely outside Next's bundler/dev
// server (see route.test.ts).
import { createAdminClient } from "../../../../lib/supabase/admin.ts";
import {
  getMetaAccessToken,
  getMetaAppSecret,
  getMetaWebhookVerifyToken,
} from "../../../../lib/meta/env.ts";
import { verifyMetaWebhookSignature } from "../../../../lib/meta/webhook-signature.ts";
import { parseLeadgenWebhookEntries } from "../../../../lib/meta/webhook-payload.ts";
import { createSupabaseMetaIngestionRepo } from "../../../../lib/meta/repo.ts";
import { processOneLeadgenId } from "../../../../lib/meta/ingest.ts";
import { makePageAccessTokenDeriver, fetchLeadByLeadgenId } from "../../../../lib/meta/graph.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEmailProvider } from "../../../../lib/notifications/get-email-provider.ts";
import { getAppBaseUrl, getGalNotificationEmail } from "../../../../lib/notifications/env.ts";
import { buildWhatsAppUrl } from "../../../../lib/notifications/reminder-logic.ts";
import {
  shouldSendNewLeadNotification,
  sendNewLeadNotification,
} from "../../../../lib/notifications/new-lead-notification.ts";
import type { ProcessOutcome } from "../../../../lib/meta/ingest.ts";
import type { LeadgenWebhookEntry } from "../../../../lib/meta/webhook-payload.ts";

// node:crypto (used by webhook-signature.ts) requires the Node runtime,
// not the Edge runtime.
export const runtime = "nodejs";

// Immediate new-lead email for the direct-webhook path — mirrors
// app/api/zapier/facebook-leads/route.ts's own inline version, adapted
// for this path's own shape: unlike Zapier (which already hands over
// resolved fullName/phone/email in the POST body), this route only
// gets ids back from processOneLeadgenId (see lib/meta/ingest.ts's
// ProcessOutcome — the resolved field_data was fetched deep inside
// that function via the Graph API and deliberately isn't threaded back
// out through it, to keep that pure ingestion pipeline free of
// notification concerns). One extra read of the just-created/matched
// contact row is the simplest way to get the display fields this email
// needs without changing ingest.ts's return shape. Never throws — any
// failure here is logged and swallowed; the already-persisted lead is
// unaffected. Entirely separate from, and does not replace, the
// next-day AUTOMATIC follow-up escalation.
async function notifyNewLead(
  supabase: SupabaseClient,
  outcome: Extract<ProcessOutcome, { outcome: "processed" }>,
  entry: LeadgenWebhookEntry,
  receivedAt: string
): Promise<void> {
  try {
    const appBaseUrl = getAppBaseUrl();
    const recipient = getGalNotificationEmail();

    const { data: contact, error } = await supabase
      .from("contacts")
      .select("full_name, phone, email")
      .eq("id", outcome.contactId)
      .maybeSingle();
    if (error || !contact) {
      throw new Error(`Could not load contact for new-lead notification: ${error?.message ?? "not found"}`);
    }

    await sendNewLeadNotification({
      provider: getEmailProvider(),
      recipient,
      lead: {
        fullName: contact.full_name as string,
        phone: (contact.phone as string | null) ?? null,
        email: (contact.email as string | null) ?? null,
        source: "Meta / Facebook Lead Ads",
        receivedAtIso: entry.createdTimeIso ?? receivedAt,
        campaignName: entry.campaignId, // direct webhook exposes only ids, no names
        formName: entry.formId,
        adName: entry.adId,
        recordUrl: `${appBaseUrl}/leads/${outcome.leadId}`,
        whatsappUrl: buildWhatsAppUrl((contact.phone as string | null) ?? null),
      },
      recordNotification: async (result) => {
        // Always the row's FIRST notification attempt (fresh rows start
        // notification_attempt_count at 0) — no concurrency risk here,
        // unlike processNewLeadNotificationRetries' own CAS-based retry
        // claim (app/api/cron/follow-up-notifications).
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
    const message = err instanceof Error ? err.message : "Notification config missing";
    console.error(JSON.stringify({ step: "meta_webhook_new_lead_notification_config_error", message }));
  }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  let expectedToken: string;
  try {
    expectedToken = getMetaWebhookVerifyToken();
  } catch {
    // Missing server config — fail closed. Never log the (absent) token.
    return new Response("Webhook verification is not configured.", { status: 500 });
  }

  if (mode === "subscribe" && challenge && token === expectedToken) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Verification failed.", { status: 403 });
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-hub-signature-256");

  let appSecret: string;
  try {
    appSecret = getMetaAppSecret();
  } catch {
    return new Response("Webhook receiving is not configured.", { status: 500 });
  }

  // Nothing below this line trusts rawBody until this passes.
  if (!verifyMetaWebhookSignature(rawBody, signatureHeader, appSecret)) {
    return new Response("Invalid signature.", { status: 401 });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON body.", { status: 400 });
  }

  const entries = parseLeadgenWebhookEntries(parsedBody);
  if (entries.length === 0) {
    // Signature-verified but not a leadgen change (e.g. some other
    // subscribed field) — acknowledge safely, nothing to process.
    return Response.json({ received: true, processed: 0 });
  }

  let metaAccessToken: string;
  try {
    metaAccessToken = getMetaAccessToken();
  } catch {
    return new Response("Meta access is not configured.", { status: 500 });
  }

  const supabase = createAdminClient();
  const repo = createSupabaseMetaIngestionRepo(supabase);
  const derivePageAccessToken = makePageAccessTokenDeriver(metaAccessToken);
  const receivedAt = new Date().toISOString();

  const results: { leadgenId: string; outcome: string }[] = [];
  let anyFailed = false;

  for (const entry of entries) {
    const outcome = await processOneLeadgenId(
      repo,
      entry.leadgenId,
      {
        metaPageId: entry.pageId,
        metaFormId: entry.formId,
        metaAdId: entry.adId,
        metaAdsetId: entry.adsetId,
        metaCampaignId: entry.campaignId,
        receivedAt,
        // The webhook "value" object itself never contains field_data —
        // see the migration's raw_payload comment. Safe to store verbatim.
        rawPayload: entry as unknown as Record<string, unknown>,
      },
      { derivePageAccessToken, fetchLead: fetchLeadByLeadgenId }
    );
    if (outcome.outcome === "failed") anyFailed = true;
    // Only ids and outcome labels — never field_data/phone/email.
    results.push({ leadgenId: entry.leadgenId, outcome: outcome.outcome });

    // Immediate new-lead email — at most once, only for a genuinely
    // first-time-processed lead (see shouldSendNewLeadNotification).
    // Entirely separate from, and does not replace, the next-day
    // AUTOMATIC follow-up escalation.
    if (shouldSendNewLeadNotification(outcome)) {
      await notifyNewLead(supabase, outcome, entry, receivedAt);
    }
  }

  console.log(JSON.stringify({ step: "leadgen_webhook_processed", results }));

  // A genuine processing failure returns non-2xx so Meta's own webhook
  // delivery retries with its own backoff (see lib/meta/ingest.ts for
  // why this is the chosen retry mechanism instead of a queue).
  if (anyFailed) {
    return Response.json({ received: true, results }, { status: 500 });
  }
  return Response.json({ received: true, results });
}
