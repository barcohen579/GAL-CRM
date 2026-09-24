import { test } from "node:test";
import assert from "node:assert/strict";
import { parseZapierLeadPayload } from "./zapier-payload.ts";

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    facebookLeadId: "fb-lead-123",
    fullName: "ישראל ישראלי",
    phone: "0501234567",
    email: "test@example.com",
    source: "Facebook Lead Ads",
    campaignName: "קמפיין קיץ",
    formName: "טופס ליד",
    adId: "ad1",
    adName: "מודעה א",
    adsetId: "adset1",
    adsetName: "אדסט א",
    campaignId: "campaign1",
    ...overrides,
  };
}

test("parseZapierLeadPayload: accepts a fully-populated valid body", () => {
  const result = parseZapierLeadPayload(validBody());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.facebookLeadId, "fb-lead-123");
  assert.equal(result.value.fullName, "ישראל ישראלי");
  assert.equal(result.value.phone, "0501234567");
  assert.equal(result.value.email, "test@example.com");
  assert.equal(result.value.campaignName, "קמפיין קיץ");
  assert.equal(result.value.formName, "טופס ליד");
  assert.equal(result.value.adId, "ad1");
  assert.equal(result.value.adsetId, "adset1");
  assert.equal(result.value.campaignId, "campaign1");
});

test("parseZapierLeadPayload: accepts the minimal required fields only, defaulting the rest to null", () => {
  const result = parseZapierLeadPayload({
    facebookLeadId: "fb-lead-456",
    fullName: "Minimal Person",
    phone: "0501234567",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.email, null);
  assert.equal(result.value.source, null);
  assert.equal(result.value.campaignName, null);
  assert.equal(result.value.formName, null);
  assert.equal(result.value.adId, null);
});

test("parseZapierLeadPayload: rejects a body missing facebookLeadId", () => {
  const body = validBody();
  delete (body as Record<string, unknown>).facebookLeadId;
  const result = parseZapierLeadPayload(body);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes("facebookLeadId")));
});

test("parseZapierLeadPayload: rejects a body missing fullName", () => {
  const body = validBody();
  delete (body as Record<string, unknown>).fullName;
  const result = parseZapierLeadPayload(body);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes("fullName")));
});

test("parseZapierLeadPayload: rejects a body missing phone", () => {
  const body = validBody();
  delete (body as Record<string, unknown>).phone;
  const result = parseZapierLeadPayload(body);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes("phone")));
});

test("parseZapierLeadPayload: rejects empty-string required fields (not just missing keys)", () => {
  const result = parseZapierLeadPayload(validBody({ fullName: "   " }));
  assert.equal(result.ok, false);
});

test("parseZapierLeadPayload: reports every missing required field at once", () => {
  const result = parseZapierLeadPayload({});
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors.length, 3);
});

test("parseZapierLeadPayload: rejects a non-object body", () => {
  assert.equal(parseZapierLeadPayload(null).ok, false);
  assert.equal(parseZapierLeadPayload("a string").ok, false);
  assert.equal(parseZapierLeadPayload(42).ok, false);
});

test('parseZapierLeadPayload: rejects an array body (guards "Wrap Request In Array" misconfiguration)', () => {
  const result = parseZapierLeadPayload([validBody()]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.toLowerCase().includes("array")));
});

test("parseZapierLeadPayload: coerces a numeric id field to a string", () => {
  const result = parseZapierLeadPayload(validBody({ campaignId: 123456789 }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.campaignId, "123456789");
});

test("parseZapierLeadPayload: parses a valid occurredAt into ISO form", () => {
  const result = parseZapierLeadPayload(validBody({ occurredAt: "2026-01-15T10:00:00Z" }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.occurredAt, "2026-01-15T10:00:00.000Z");
});

test("parseZapierLeadPayload: an unparseable occurredAt is dropped to null rather than rejected", () => {
  const result = parseZapierLeadPayload(validBody({ occurredAt: "not-a-date" }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.occurredAt, null);
});

// Lead Workflow V2: the Production Zap prefixes the real leadgen id with
// the literal text "facebookLeadId" — normalized so the Zapier and direct
// Meta webhook paths dedupe on the same key.
test("normalizeZapierFacebookLeadId: strips the literal 'facebookLeadId' prefix to the numeric leadgen id", async () => {
  const { normalizeZapierFacebookLeadId } = await import("./zapier-payload.ts");
  assert.equal(normalizeZapierFacebookLeadId("facebookLeadId1234567890123456"), "1234567890123456");
  assert.equal(normalizeZapierFacebookLeadId("1234567890123456"), "1234567890123456");
  assert.equal(normalizeZapierFacebookLeadId(" 1234567890123456 "), "1234567890123456");
  assert.equal(normalizeZapierFacebookLeadId("zap-lead-A"), "zap-lead-A");
});

test("the same Facebook lead via Zapier (prefixed id) and the direct webhook (numeric id) is ONE ingestion — the second is a duplicate", async () => {
  const { parseZapierLeadPayload } = await import("./zapier-payload.ts");
  const { processZapierLead } = await import("./zapier-ingest.ts");
  const { processOneLeadgenId } = await import("./ingest.ts");
  const { createFakeDb, createFakeMetaIngestionRepo } = await import("./fakes.ts");
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);

  const parsed = parseZapierLeadPayload({ facebookLeadId: "facebookLeadId1234567890123456", fullName: "דנה", phone: "0501234567" });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const viaZapier = await processZapierLead(repo, parsed.value, new Date().toISOString());
  assert.equal(viaZapier.outcome, "processed");

  const viaWebhook = await processOneLeadgenId(
    repo,
    "1234567890123456",
    { metaPageId: "p", metaFormId: null, metaAdId: null, metaAdsetId: null, metaCampaignId: null, receivedAt: new Date().toISOString(), rawPayload: null },
    {
      derivePageAccessToken: async () => "t",
      fetchLead: async () => { throw new Error("must not refetch a lead that was already ingested"); },
    }
  );
  assert.equal(viaWebhook.outcome, "duplicate");
  assert.equal(db.touchpoints.size, 1);
});
