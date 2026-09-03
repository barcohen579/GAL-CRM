#!/usr/bin/env node
// GAL CRM — human-readable, fully offline walkthrough of the Meta lead
// ingestion pipeline: builds a synthetic (fake) leadgen webhook, signs
// it exactly like Meta would, and drives it through the REAL
// signature-verification / payload-parsing / ingestion-orchestration
// code — but against an IN-MEMORY fake repo and a fake Meta lead fetch,
// never the live Supabase project or the real Meta API.
//
// Safe to run any time, with no environment variables, no network
// access, and no real customer data. Use this to sanity-check the
// pipeline itself (e.g. after changing lib/meta/*.ts) without waiting
// for a real Meta webhook delivery.
//
// Usage:
//   node scripts/meta-webhook-mock-demo.ts
//
// This is the manual counterpart to the automated coverage in
// lib/meta/webhook-flow.test.ts (which runs the same flow under
// `npm test`) — see that file for the assertions this script's steps
// are expected to satisfy.

import { verifyMetaWebhookSignature } from "../lib/meta/webhook-signature.ts";
import { parseLeadgenWebhookEntries } from "../lib/meta/webhook-payload.ts";
import { processOneLeadgenId } from "../lib/meta/ingest.ts";
import {
  buildMockLeadFieldData,
  buildMockWebhookBody,
  signMockWebhookBody,
} from "../lib/meta/mock-webhook.ts";
import { createFakeDb, createFakeMetaIngestionRepo, fakeDerivePageAccessToken } from "../lib/meta/fakes.ts";

const DEMO_APP_SECRET = "local-demo-secret-not-a-real-meta-secret";
const DEMO_LEADGEN_ID = `demo-${Date.now()}`;

function step(label: string, detail?: unknown) {
  console.log(`\n▶ ${label}`);
  if (detail !== undefined) console.log(JSON.stringify(detail, null, 2));
}

async function main() {
  console.log("=== Meta Lead Ads ingestion — offline mock walkthrough ===");
  console.log("(No real Meta API call, no real Supabase project touched.)");

  // 1. Build + sign a synthetic webhook body, exactly like Meta would
  //    send it (only fake ids/values).
  const body = buildMockWebhookBody([{ leadgenId: DEMO_LEADGEN_ID }]);
  const { rawBody, signatureHeader } = signMockWebhookBody(body, DEMO_APP_SECRET);
  step("1. Built + signed a synthetic webhook delivery", { leadgenId: DEMO_LEADGEN_ID });

  // 2. Verify the signature with the REAL verification function — this
  //    is exactly what app/api/meta/leadgen-webhook/route.ts's POST
  //    handler does first, before trusting anything in the body.
  const signatureOk = verifyMetaWebhookSignature(rawBody, signatureHeader, DEMO_APP_SECRET);
  step("2. Signature verification", { valid: signatureOk });
  if (!signatureOk) {
    console.error("Signature verification failed unexpectedly — aborting demo.");
    process.exit(1);
  }

  // 3. Parse the (now-trusted) body into leadgen entries.
  const entries = parseLeadgenWebhookEntries(JSON.parse(rawBody));
  step("3. Parsed leadgen entries", entries);

  // 4. Process each entry through the real ingestion pipeline, using a
  //    fresh in-memory fake repo (stands in for Supabase) and a fake
  //    Meta lead fetch (stands in for the real Graph API call) that
  //    returns obviously-synthetic field_data.
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);
  const fetchLead = async () => ({
    id: DEMO_LEADGEN_ID,
    createdTimeIso: new Date().toISOString(),
    adId: "000000000000004",
    adsetId: "000000000000003",
    campaignId: "000000000000005",
    formId: "000000000000002",
    fieldData: buildMockLeadFieldData({ fullName: "Demo Test Lead" }),
  });

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
        receivedAt: new Date().toISOString(),
        rawPayload: entry as unknown as Record<string, unknown>,
      },
      { derivePageAccessToken: fakeDerivePageAccessToken, fetchLead }
    );
    step("4. Ingestion outcome", outcome);
  }

  // 5. Show the resulting (fake, in-memory) CRM state.
  step("5. Resulting fake DB contents", {
    ingestions: [...db.ingestions.values()].map((row) => {
      // _updatedAtMs is an internal-only field of the fake (see
      // lib/meta/fakes.ts) — strip it for a clean demo printout.
      const clone: Record<string, unknown> = { ...row };
      delete clone._updatedAtMs;
      return clone;
    }),
    contacts: [...db.contacts.values()],
    leads: [...db.leads.values()],
    touchpoints: [...db.touchpoints.values()],
  });

  console.log("\n=== Done. Nothing above touched the real Supabase project or Meta API. ===");
}

main().catch((err) => {
  console.error("Demo failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
