import { test } from "node:test";
import assert from "node:assert/strict";
import { processOneLeadgenId, sanitizeErrorMessage } from "./ingest.ts";
import {
  createFakeDb,
  createFakeMetaIngestionRepo,
  fakeDerivePageAccessToken,
  makeFakeFetchLead,
  seedContact,
  seedLead,
} from "./fakes.ts";
import type { NewIngestionFields } from "./repo.ts";

function webhookFields(overrides: Partial<NewIngestionFields> = {}): NewIngestionFields {
  return {
    metaPageId: "166795883755512",
    metaFormId: "form1",
    metaAdId: "ad1",
    metaAdsetId: "adset1",
    metaCampaignId: "campaign1",
    receivedAt: new Date().toISOString(),
    rawPayload: null,
    ...overrides,
  };
}

test("processOneLeadgenId: creates a new contact, lead and touchpoint end to end", async () => {
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);
  const fetchLead = makeFakeFetchLead({
    fieldData: [
      { name: "full_name", values: ["Test Person"] },
      { name: "phone_number", values: ["0501234567"] },
      { name: "email", values: ["test@example.com"] },
    ],
  });

  const outcome = await processOneLeadgenId(repo, "lead-abc", webhookFields(), {
    derivePageAccessToken: fakeDerivePageAccessToken,
    fetchLead,
  });

  assert.equal(outcome.outcome, "processed");
  assert.equal(db.contacts.size, 1);
  assert.equal(db.leads.size, 1);
  assert.equal(db.touchpoints.size, 1);
  const ingestion = await repo.getIngestionRowByLeadgenId("lead-abc");
  assert.equal(ingestion?.status, "PROCESSED");
});

test("duplicate leadgen_id: a second delivery for the same leadgen_id does not duplicate CRM entities", async () => {
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);
  const fetchLead = makeFakeFetchLead({
    fieldData: [
      { name: "full_name", values: ["Test Person"] },
      { name: "phone_number", values: ["0501234567"] },
    ],
  });
  const deps = { derivePageAccessToken: fakeDerivePageAccessToken, fetchLead };

  const first = await processOneLeadgenId(repo, "dup-lead", webhookFields(), deps);
  assert.equal(first.outcome, "processed");

  // Redelivery: same leadgen_id, webhook fields supplied again (as a
  // real redelivery would), but no new row / entities should result.
  const second = await processOneLeadgenId(repo, "dup-lead", webhookFields(), deps);
  assert.equal(second.outcome, "duplicate");

  assert.equal(db.ingestions.size, 1, "only one ingestion row for this leadgen_id");
  assert.equal(db.contacts.size, 1, "no duplicate contact");
  assert.equal(db.leads.size, 1, "no duplicate lead");
  assert.equal(db.touchpoints.size, 1, "no duplicate touchpoint");
});

test("contact matching: same contact matched by normalized phone even with different formatting", async () => {
  const db = createFakeDb();
  const existingContactId = seedContact(db, { fullName: "Existing Person", phone: "050-123-4567" });
  const repo = createFakeMetaIngestionRepo(db);
  // Meta commonly supplies E.164; the stored contact uses local dashed
  // format — normalization must still match these as the same person.
  const fetchLead = makeFakeFetchLead({
    fieldData: [
      { name: "full_name", values: ["Existing Person"] },
      { name: "phone_number", values: ["+972501234567"] },
    ],
  });

  const outcome = await processOneLeadgenId(repo, "lead-phone-match", webhookFields(), {
    derivePageAccessToken: fakeDerivePageAccessToken,
    fetchLead,
  });

  assert.equal(outcome.outcome, "processed");
  assert.equal(db.contacts.size, 1, "no new contact created — reused the existing one");
  if (outcome.outcome === "processed") {
    assert.equal(outcome.contactId, existingContactId);
  }
});

test("contact matching: falls back to normalized email when phone doesn't match", async () => {
  const db = createFakeDb();
  const existingContactId = seedContact(db, {
    fullName: "Existing Person",
    phone: null,
    email: "Existing@Example.com",
  });
  const repo = createFakeMetaIngestionRepo(db);
  const fetchLead = makeFakeFetchLead({
    fieldData: [
      { name: "full_name", values: ["Existing Person"] },
      { name: "email", values: ["existing@example.com"] }, // different case, same normalized value
    ],
  });

  const outcome = await processOneLeadgenId(repo, "lead-email-match", webhookFields(), {
    derivePageAccessToken: fakeDerivePageAccessToken,
    fetchLead,
  });

  assert.equal(outcome.outcome, "processed");
  assert.equal(db.contacts.size, 1);
  if (outcome.outcome === "processed") {
    assert.equal(outcome.contactId, existingContactId);
  }
});

test("contact matching: never fuzzy-matches by name alone — a same-name, different-phone lead creates a new contact", async () => {
  const db = createFakeDb();
  seedContact(db, { fullName: "Same Name", phone: "0501111111", email: null });
  const repo = createFakeMetaIngestionRepo(db);
  const fetchLead = makeFakeFetchLead({
    fieldData: [
      { name: "full_name", values: ["Same Name"] },
      { name: "phone_number", values: ["0509999999"] },
    ],
  });

  const outcome = await processOneLeadgenId(repo, "lead-name-only", webhookFields(), {
    derivePageAccessToken: fakeDerivePageAccessToken,
    fetchLead,
  });

  assert.equal(outcome.outcome, "processed");
  assert.equal(db.contacts.size, 2, "a same-named but unmatched-phone lead must create a NEW contact");
});

test("lead reuse: an existing OPEN lead is reused, not duplicated, and its stage is never reset", async () => {
  const db = createFakeDb();
  const contactId = seedContact(db, { fullName: "Existing Person", phone: "0501234567" });
  const openLeadId = seedLead(db, contactId, "INTERESTED");
  const repo = createFakeMetaIngestionRepo(db);
  const fetchLead = makeFakeFetchLead({
    fieldData: [
      { name: "full_name", values: ["Existing Person"] },
      { name: "phone_number", values: ["0501234567"] },
    ],
  });

  const outcome = await processOneLeadgenId(repo, "lead-reuse-open", webhookFields(), {
    derivePageAccessToken: fakeDerivePageAccessToken,
    fetchLead,
  });

  assert.equal(outcome.outcome, "processed");
  assert.equal(db.leads.size, 1, "no new lead created — the open lead was reused");
  if (outcome.outcome === "processed") {
    assert.equal(outcome.leadId, openLeadId);
  }
  assert.equal(db.leads.get(openLeadId)?.stage, "INTERESTED", "stage must never be reset");
});

test("lead reuse: when every existing lead is closed (WON/LOST), a new lead is created", async () => {
  const db = createFakeDb();
  const contactId = seedContact(db, { fullName: "Existing Person", phone: "0501234567" });
  seedLead(db, contactId, "WON");
  seedLead(db, contactId, "LOST");
  const repo = createFakeMetaIngestionRepo(db);
  const fetchLead = makeFakeFetchLead({
    fieldData: [
      { name: "full_name", values: ["Existing Person"] },
      { name: "phone_number", values: ["0501234567"] },
    ],
  });

  const outcome = await processOneLeadgenId(repo, "lead-reuse-closed", webhookFields(), {
    derivePageAccessToken: fakeDerivePageAccessToken,
    fetchLead,
  });

  assert.equal(outcome.outcome, "processed");
  assert.equal(db.leads.size, 3, "a brand new lead was created alongside the two closed ones");
});

test("touchpoint created exactly once even if matchAndCreateCrmEntities logic runs twice for the same leadgen_id", async () => {
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);
  const fetchLead = makeFakeFetchLead({
    fieldData: [
      { name: "full_name", values: ["Test Person"] },
      { name: "phone_number", values: ["0501234567"] },
    ],
  });
  const deps = { derivePageAccessToken: fakeDerivePageAccessToken, fetchLead };

  await processOneLeadgenId(repo, "lead-tp-once", webhookFields(), deps);
  // Simulate the reprocessing script being run again on a leadgen_id
  // that (from the caller's point of view) looked FAILED/PENDING but
  // actually already has a touchpoint — no webhookFields supplied,
  // matching the reprocessor's real call shape.
  await processOneLeadgenId(repo, "lead-tp-once", null, deps);

  assert.equal(db.touchpoints.size, 1);
});

test("failed ingestion remains retryable: a thrown error marks the row FAILED (not a terminal state) and a retry can still succeed", async () => {
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);

  let shouldFail = true;
  const flakyFetchLead = async () => {
    if (shouldFail) throw new Error("Meta API error (HTTP 500): unknown  — temporary outage");
    return {
      id: "fake",
      createdTimeIso: null,
      adId: null,
      adsetId: null,
      campaignId: null,
      formId: null,
      fieldData: [
        { name: "full_name", values: ["Test Person"] },
        { name: "phone_number", values: ["0501234567"] },
      ],
    };
  };

  const first = await processOneLeadgenId(repo, "lead-retry", webhookFields(), {
    derivePageAccessToken: fakeDerivePageAccessToken,
    fetchLead: flakyFetchLead,
  });
  assert.equal(first.outcome, "failed");
  const afterFailure = await repo.getIngestionRowByLeadgenId("lead-retry");
  assert.equal(afterFailure?.status, "FAILED");
  assert.equal(afterFailure?.processed_at, null);

  shouldFail = false;
  // Reprocessing script call shape: leadgen_id only, no webhookFields.
  const second = await processOneLeadgenId(repo, "lead-retry", null, {
    derivePageAccessToken: fakeDerivePageAccessToken,
    fetchLead: flakyFetchLead,
  });
  assert.equal(second.outcome, "processed");
  assert.equal(db.contacts.size, 1);
  assert.equal(db.leads.size, 1);
  assert.equal(db.touchpoints.size, 1);
});

test("in-flight duplicate: claiming an already-PROCESSING row does not reprocess it", async () => {
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);
  const row = await repo.insertIngestionRow("lead-inflight", webhookFields());
  await repo.claimForProcessing(row.id); // simulate another delivery already claiming it

  const outcome = await processOneLeadgenId(repo, "lead-inflight", webhookFields(), {
    derivePageAccessToken: fakeDerivePageAccessToken,
    fetchLead: makeFakeFetchLead({ fieldData: [] }),
  });

  assert.equal(outcome.outcome, "in_progress_elsewhere");
  assert.equal(db.contacts.size, 0);
  assert.equal(db.leads.size, 0);
  assert.equal(db.touchpoints.size, 0);
});

test("sanitizeErrorMessage: redacts email-like and long digit-run content defensively", () => {
  const msg = sanitizeErrorMessage(new Error("failed for person@example.com at 0501234567"));
  assert.ok(!msg.includes("person@example.com"));
  assert.ok(!msg.includes("0501234567"));
});

test("sanitizeErrorMessage: truncates very long messages", () => {
  const msg = sanitizeErrorMessage(new Error("x".repeat(1000)));
  assert.ok(msg.length <= 501);
});
