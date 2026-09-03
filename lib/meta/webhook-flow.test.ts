// End-to-end MOCK webhook flow test — exercises the exact same real
// code the HTTP route uses at every step (signature verification,
// payload parsing, ingestion orchestration, contact/lead/touchpoint
// matching) with a synthetic, signed webhook body and a fake
// repo/Meta-fetch standing in for Supabase/Meta. This is the
// "local/integration testing without real Meta writes" mechanism
// (Phase 3C item 10) — see also scripts/meta-webhook-mock-demo.ts for
// the same flow as a runnable, human-readable script.
//
// No real Supabase project, no real Meta API, no real customer PII is
// ever touched by this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyMetaWebhookSignature } from "./webhook-signature.ts";
import { parseLeadgenWebhookEntries } from "./webhook-payload.ts";
import { processOneLeadgenId } from "./ingest.ts";
import {
  buildMockLeadFieldData,
  buildMockWebhookBody,
  signMockWebhookBody,
} from "./mock-webhook.ts";
import { createFakeDb, createFakeMetaIngestionRepo, fakeDerivePageAccessToken } from "./fakes.ts";

const TEST_APP_SECRET = "mock-flow-test-secret";

// Mirrors app/api/meta/leadgen-webhook/route.ts's POST handler's own
// per-entry loop, using fakes instead of the real admin client/Meta
// client — this is the "drive a signed HTTP-shaped payload through the
// real pipeline" harness.
async function runMockWebhookThroughPipeline(
  rawBody: string,
  signatureHeader: string,
  repo: ReturnType<typeof createFakeMetaIngestionRepo>,
  fetchLead: Parameters<typeof processOneLeadgenId>[3]["fetchLead"]
) {
  if (!verifyMetaWebhookSignature(rawBody, signatureHeader, TEST_APP_SECRET)) {
    throw new Error("signature verification failed — this test payload should always verify");
  }
  const parsedBody: unknown = JSON.parse(rawBody);
  const entries = parseLeadgenWebhookEntries(parsedBody);
  const receivedAt = new Date().toISOString();

  const outcomes = [];
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
        rawPayload: entry as unknown as Record<string, unknown>,
      },
      { derivePageAccessToken: fakeDerivePageAccessToken, fetchLead }
    );
    outcomes.push({ leadgenId: entry.leadgenId, outcome });
  }
  return outcomes;
}

test("mock webhook flow: signature -> parse -> ingest -> mocked Meta fetch -> contact -> lead -> touchpoint -> PROCESSED", async () => {
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);

  const body = buildMockWebhookBody([{ leadgenId: "mock-flow-lead-1" }]);
  const { rawBody, signatureHeader } = signMockWebhookBody(body, TEST_APP_SECRET);

  const fetchLead = async () => ({
    id: "mock-flow-lead-1",
    createdTimeIso: new Date().toISOString(),
    adId: "000000000000004",
    adsetId: "000000000000003",
    campaignId: "000000000000005",
    formId: "000000000000002",
    fieldData: buildMockLeadFieldData(),
  });

  const outcomes = await runMockWebhookThroughPipeline(rawBody, signatureHeader, repo, fetchLead);

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].outcome.outcome, "processed");
  assert.equal(db.contacts.size, 1);
  assert.equal(db.leads.size, 1);
  assert.equal(db.touchpoints.size, 1);

  const finalRow = await repo.getIngestionRowByLeadgenId("mock-flow-lead-1");
  assert.equal(finalRow?.status, "PROCESSED");
  assert.ok(finalRow?.contact_id && finalRow?.lead_id && finalRow?.touchpoint_id);
});

test("mock webhook flow: a tampered mock payload is rejected before ingestion runs at all", async () => {
  const body = buildMockWebhookBody([{ leadgenId: "mock-flow-tamper" }]);
  const { signatureHeader } = signMockWebhookBody(body, TEST_APP_SECRET);
  const tamperedRawBody = JSON.stringify(buildMockWebhookBody([{ leadgenId: "attacker-injected-id" }]));

  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);

  await assert.rejects(
    runMockWebhookThroughPipeline(tamperedRawBody, signatureHeader, repo, async () => {
      throw new Error("must never be called — signature check must reject first");
    }),
    /signature verification failed/
  );
  assert.equal(db.ingestions.size, 0);
});

test("mock webhook flow: duplicate leadgen_id appearing twice in the SAME POST body still yields exactly one entity set", async () => {
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);

  // A redundant/duplicated "changes" entry for the same leadgen_id
  // within one delivery — realistic enough to guard against (Meta's
  // batching is not something this code should have to trust blindly).
  const body = buildMockWebhookBody([
    { leadgenId: "mock-flow-dup-in-post" },
    { leadgenId: "mock-flow-dup-in-post" },
  ]);
  const { rawBody, signatureHeader } = signMockWebhookBody(body, TEST_APP_SECRET);
  const fetchLead = async () => ({
    id: "mock-flow-dup-in-post",
    createdTimeIso: null,
    adId: null,
    adsetId: null,
    campaignId: null,
    formId: null,
    fieldData: buildMockLeadFieldData(),
  });

  const outcomes = await runMockWebhookThroughPipeline(rawBody, signatureHeader, repo, fetchLead);

  assert.equal(outcomes.length, 2, "both entries were parsed and looped over");
  assert.equal(outcomes[0].outcome.outcome, "processed");
  assert.equal(outcomes[1].outcome.outcome, "duplicate", "the second, identical entry is recognized as a duplicate");
  assert.equal(db.contacts.size, 1);
  assert.equal(db.leads.size, 1);
  assert.equal(db.touchpoints.size, 1);
});

test("mock webhook flow: a mix of one valid and one malformed change does not corrupt the valid one", async () => {
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);

  // Hand-build the body so one "changes" entry is missing leadgen_id
  // (malformed/unusable) alongside one genuinely valid leadgen change —
  // parseLeadgenWebhookEntries must drop only the bad one.
  const body = {
    object: "page",
    entry: [
      {
        id: "000000000000001",
        changes: [
          { field: "leadgen", value: { page_id: "000000000000001" /* missing leadgen_id */ } },
          { field: "leadgen", value: { leadgen_id: "mock-flow-mixed-valid", page_id: "000000000000001" } },
        ],
      },
    ],
  };
  const { rawBody, signatureHeader } = signMockWebhookBody(body, TEST_APP_SECRET);
  const fetchLead = async () => ({
    id: "mock-flow-mixed-valid",
    createdTimeIso: null,
    adId: null,
    adsetId: null,
    campaignId: null,
    formId: null,
    fieldData: buildMockLeadFieldData(),
  });

  const outcomes = await runMockWebhookThroughPipeline(rawBody, signatureHeader, repo, fetchLead);

  // Response behavior (documented, matches app/api/meta/leadgen-webhook/route.ts):
  // parseLeadgenWebhookEntries silently drops entries it cannot extract
  // a leadgen_id from — a malformed/partial change never becomes a
  // processing attempt (and never marks anything FAILED), while every
  // other, well-formed change in the same POST is still processed
  // normally. The webhook response as a whole is still 200 as long as
  // no entry that WAS attempted failed.
  assert.equal(outcomes.length, 1, "the malformed change was silently dropped, not attempted");
  assert.equal(outcomes[0].leadgenId, "mock-flow-mixed-valid");
  assert.equal(outcomes[0].outcome.outcome, "processed");
});

test("mock webhook flow: one entry failing in a multi-entry POST does not block or duplicate the other, and a Meta-style redelivery of the WHOLE POST self-heals", async () => {
  // Mirrors app/api/meta/leadgen-webhook/route.ts's own aggregation:
  // it returns HTTP 500 for the whole delivery when ANY entry failed,
  // which makes Meta redeliver the ENTIRE POST body again. This test
  // proves that redelivery is safe: the already-succeeded entry is
  // recognized as a duplicate (no reprocessing, no duplication) while
  // the previously-failed one gets a genuine retry and can now succeed.
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);

  const body = buildMockWebhookBody([
    { leadgenId: "mock-flow-partial-ok" },
    { leadgenId: "mock-flow-partial-fail" },
  ]);
  const { rawBody, signatureHeader } = signMockWebhookBody(body, TEST_APP_SECRET);

  let failSecond = true;
  const fetchLead = async (leadgenId: string) => {
    if (leadgenId === "mock-flow-partial-fail" && failSecond) {
      throw new Error("Meta API error (HTTP 500): unknown  — simulated transient outage");
    }
    return {
      id: leadgenId,
      createdTimeIso: null,
      adId: null,
      adsetId: null,
      campaignId: null,
      formId: null,
      fieldData: buildMockLeadFieldData(),
    };
  };

  // First delivery attempt.
  const first = await runMockWebhookThroughPipeline(rawBody, signatureHeader, repo, fetchLead);
  assert.equal(first[0].outcome.outcome, "processed");
  assert.equal(first[1].outcome.outcome, "failed");
  const anyFailedFirst = first.some((o) => o.outcome.outcome === "failed");
  assert.equal(anyFailedFirst, true, "route.ts would return HTTP 500 here, prompting a Meta redelivery");
  assert.equal(db.contacts.size, 1, "only the successful entry created a contact so far");

  // Meta redelivers the identical POST body (this is what a real 500
  // response triggers) — the underlying transient failure is now gone.
  failSecond = false;
  const second = await runMockWebhookThroughPipeline(rawBody, signatureHeader, repo, fetchLead);
  assert.equal(second[0].outcome.outcome, "duplicate", "already-processed entry is not reprocessed");
  assert.equal(second[1].outcome.outcome, "processed", "previously-failed entry now succeeds");
  const anyFailedSecond = second.some((o) => o.outcome.outcome === "failed");
  assert.equal(anyFailedSecond, false, "route.ts would return HTTP 200 now — delivery fully resolved");

  // Both entries' mocked field_data resolve to the same fake
  // phone/email, so they correctly match to the SAME contact and reuse
  // its still-OPEN lead — this is matchAndCreateCrmEntities working as
  // intended (see "lead reuse" rules), not a leftover duplication bug.
  // Each leadgen_id still gets exactly its own touchpoint.
  assert.equal(db.contacts.size, 1, "same fake phone in both mocked leads correctly matches one contact");
  assert.equal(db.leads.size, 1, "the second entry reuses the first entry's still-OPEN lead");
  assert.equal(db.touchpoints.size, 2, "each distinct leadgen_id still gets its own touchpoint");
});
