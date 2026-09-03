import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLeadgenWebhookEntries } from "./webhook-payload.ts";

test("parseLeadgenWebhookEntries: extracts a single leadgen change", () => {
  const body = {
    object: "page",
    entry: [
      {
        id: "166795883755512",
        time: 1234567890,
        changes: [
          {
            field: "leadgen",
            value: {
              leadgen_id: "lead123",
              page_id: "166795883755512",
              form_id: "form456",
              adgroup_id: "adset789",
              ad_id: "ad111",
              campaign_id: "camp222",
              created_time: 1700000000,
            },
          },
        ],
      },
    ],
  };
  const entries = parseLeadgenWebhookEntries(body);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    leadgenId: "lead123",
    pageId: "166795883755512",
    formId: "form456",
    adId: "ad111",
    adsetId: "adset789",
    campaignId: "camp222",
    createdTimeIso: new Date(1700000000 * 1000).toISOString(),
  });
});

// Regression coverage for the Phase 3D production incident: the
// leadgen WEBHOOK NOTIFICATION payload's ad-set field is genuinely
// named "adgroup_id" — a DIFFERENT Meta API surface from the
// Lead-detail node (/{leadgen_id}), which uses "adset_id" (see
// lib/meta/graph.ts and its own tests). This file's use of
// "adgroup_id" is correct and must never be "fixed" to match the
// other surface.
test("parseLeadgenWebhookEntries: the webhook's adgroup_id field still maps to internal adsetId", () => {
  const body = {
    object: "page",
    entry: [
      {
        id: "166795883755512",
        changes: [
          {
            field: "leadgen",
            value: {
              leadgen_id: "lead999",
              page_id: "166795883755512",
              adgroup_id: "webhook-adset-value",
            },
          },
        ],
      },
    ],
  };
  const entries = parseLeadgenWebhookEntries(body);
  assert.equal(entries[0].adsetId, "webhook-adset-value");
});

test("parseLeadgenWebhookEntries: handles multiple entries and multiple changes", () => {
  const body = {
    object: "page",
    entry: [
      {
        id: "page1",
        changes: [
          { field: "leadgen", value: { leadgen_id: "l1", page_id: "page1" } },
          { field: "leadgen", value: { leadgen_id: "l2", page_id: "page1" } },
        ],
      },
      {
        id: "page2",
        changes: [{ field: "leadgen", value: { leadgen_id: "l3", page_id: "page2" } }],
      },
    ],
  };
  const entries = parseLeadgenWebhookEntries(body);
  assert.deepEqual(
    entries.map((e) => e.leadgenId),
    ["l1", "l2", "l3"]
  );
});

test("parseLeadgenWebhookEntries: falls back to entry.id for page_id when value.page_id is absent", () => {
  const body = {
    object: "page",
    entry: [
      { id: "fallback-page", changes: [{ field: "leadgen", value: { leadgen_id: "l1" } }] },
    ],
  };
  const entries = parseLeadgenWebhookEntries(body);
  assert.equal(entries[0].pageId, "fallback-page");
});

test("parseLeadgenWebhookEntries: ignores unrelated change fields safely", () => {
  const body = {
    object: "page",
    entry: [
      {
        id: "page1",
        changes: [
          { field: "feed", value: { some: "unrelated data" } },
          { field: "leadgen", value: { leadgen_id: "l1", page_id: "page1" } },
        ],
      },
    ],
  };
  const entries = parseLeadgenWebhookEntries(body);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].leadgenId, "l1");
});

test("parseLeadgenWebhookEntries: ignores unrelated object types safely", () => {
  assert.deepEqual(parseLeadgenWebhookEntries({ object: "instagram", entry: [] }), []);
});

test("parseLeadgenWebhookEntries: never throws on malformed/unexpected shapes", () => {
  assert.deepEqual(parseLeadgenWebhookEntries(null), []);
  assert.deepEqual(parseLeadgenWebhookEntries(undefined), []);
  assert.deepEqual(parseLeadgenWebhookEntries("a string"), []);
  assert.deepEqual(parseLeadgenWebhookEntries({}), []);
  assert.deepEqual(parseLeadgenWebhookEntries({ object: "page", entry: "not-an-array" }), []);
  assert.deepEqual(
    parseLeadgenWebhookEntries({ object: "page", entry: [{ changes: [{ field: "leadgen", value: {} }] }] }),
    []
  );
});
