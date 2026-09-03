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

// node:crypto (used by webhook-signature.ts) requires the Node runtime,
// not the Edge runtime.
export const runtime = "nodejs";

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
