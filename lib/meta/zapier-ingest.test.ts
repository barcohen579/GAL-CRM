import { test } from "node:test";
import assert from "node:assert/strict";
import { processZapierLead } from "./zapier-ingest.ts";
import { createFakeDb, createFakeMetaIngestionRepo, seedContact, seedLead } from "./fakes.ts";
import type { ZapierLeadInput } from "./zapier-payload.ts";

function zapierInput(overrides: Partial<ZapierLeadInput> = {}): ZapierLeadInput {
  return {
    facebookLeadId: "zap-lead-1",
    fullName: "Test Person",
    phone: "0501234567",
    email: "test@example.com",
    source: "Facebook Lead Ads",
    campaignName: "Summer Campaign",
    formName: "Lead Form",
    adId: "ad1",
    adName: "Ad One",
    adsetId: "adset1",
    adsetName: "Adset One",
    campaignId: "campaign1",
    pageId: null,
    formId: null,
    occurredAt: null,
    ...overrides,
  };
}

test("processZapierLead: creates a new contact, lead and touchpoint end to end", async () => {
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);

  const outcome = await processZapierLead(repo, zapierInput(), new Date().toISOString());

  assert.equal(outcome.outcome, "processed");
  assert.equal(db.contacts.size, 1);
  assert.equal(db.leads.size, 1);
  assert.equal(db.touchpoints.size, 1);

  const ingestion = await repo.getIngestionRowByLeadgenId("zap-lead-1");
  assert.equal(ingestion?.status, "PROCESSED");

  const touchpoint = [...db.touchpoints.values()][0];
  assert.equal(touchpoint.channel, "META_AD");
  assert.equal(touchpoint.external_ref, "zap-lead-1");
  assert.equal(touchpoint.is_primary, true);
});

test("processZapierLead: a second delivery for the same facebookLeadId does not duplicate CRM entities", async () => {
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);

  const first = await processZapierLead(repo, zapierInput(), new Date().toISOString());
  assert.equal(first.outcome, "processed");

  const second = await processZapierLead(repo, zapierInput(), new Date().toISOString());
  assert.equal(second.outcome, "duplicate");
  assert.equal(second.contactId, first.outcome === "processed" ? first.contactId : null);
  assert.equal(second.leadId, first.outcome === "processed" ? first.leadId : null);

  assert.equal(db.contacts.size, 1);
  assert.equal(db.leads.size, 1);
  assert.equal(db.touchpoints.size, 1);
});

test("processZapierLead: two different facebookLeadIds for the same phone number reuse the same contact and open lead", async () => {
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);

  const first = await processZapierLead(
    repo,
    zapierInput({ facebookLeadId: "zap-lead-A", phone: "0501234567" }),
    new Date().toISOString()
  );
  const second = await processZapierLead(
    repo,
    zapierInput({ facebookLeadId: "zap-lead-B", phone: "050-123-4567" }),
    new Date().toISOString()
  );

  assert.equal(first.outcome, "processed");
  assert.equal(second.outcome, "processed");
  if (first.outcome !== "processed" || second.outcome !== "processed") return;

  assert.equal(first.contactId, second.contactId);
  assert.equal(first.leadId, second.leadId);
  assert.equal(db.contacts.size, 1);
  assert.equal(db.leads.size, 1);
  assert.equal(db.touchpoints.size, 2);
});

test("processZapierLead: reuses an existing OPEN lead for a contact matched by phone, without resetting its stage", async () => {
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);
  const contactId = seedContact(db, { fullName: "Existing Person", phone: "0501234567" });
  const leadId = seedLead(db, contactId, "CONTACTED");

  const outcome = await processZapierLead(
    repo,
    zapierInput({ phone: "0501234567" }),
    new Date().toISOString()
  );

  assert.equal(outcome.outcome, "processed");
  if (outcome.outcome !== "processed") return;
  assert.equal(outcome.contactId, contactId);
  assert.equal(outcome.leadId, leadId);
  assert.equal(db.leads.get(leadId)?.stage, "CONTACTED"); // never reset
});

test("processZapierLead: a contact whose only lead is WON/LOST gets a new lead instead of reusing the closed one", async () => {
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);
  const contactId = seedContact(db, { fullName: "Existing Person", phone: "0501234567" });
  const closedLeadId = seedLead(db, contactId, "WON");

  const outcome = await processZapierLead(
    repo,
    zapierInput({ phone: "0501234567" }),
    new Date().toISOString()
  );

  assert.equal(outcome.outcome, "processed");
  if (outcome.outcome !== "processed") return;
  assert.equal(outcome.contactId, contactId);
  assert.notEqual(outcome.leadId, closedLeadId);
});

test("processZapierLead: missing full name falls back to a non-empty placeholder rather than violating the NOT NULL constraint", async () => {
  const db = createFakeDb();
  const repo = createFakeMetaIngestionRepo(db);

  // Not expected in practice (fullName is required by parseZapierLeadPayload
  // before this is ever called), but processZapierLead itself must stay
  // safe if ever invoked with an empty string.
  const outcome = await processZapierLead(
    repo,
    zapierInput({ fullName: "" }),
    new Date().toISOString()
  );
  assert.equal(outcome.outcome, "processed");
  if (outcome.outcome !== "processed") return;
  const contact = db.contacts.get(outcome.contactId);
  assert.ok(contact && contact.full_name.length > 0);
});
