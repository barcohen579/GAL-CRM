// Tests the route's own auth + validation logic by calling the
// exported POST handler directly with real Request objects — no
// running server needed. These paths all return before ever touching
// Supabase, so no live Supabase/env config is needed for them. Deeper
// ingestion behavior (matching/idempotency/lead creation) is covered by
// lib/meta/zapier-ingest.test.ts against the shared, DI-friendly
// processZapierLead — this file only covers what's specific to the HTTP
// layer itself. Mirrors app/api/meta/leadgen-webhook/route.test.ts's
// own structure and withEnv helper.

import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "./route.ts";

const URL = "http://localhost/api/zapier/facebook-leads";
const SECRET = "test-zapier-secret";

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    facebookLeadId: "fb-lead-route-test",
    fullName: "Test Person",
    phone: "0501234567",
    email: "test@example.com",
    source: "Facebook Lead Ads",
    campaignName: "Campaign",
    formName: "Form",
    ...overrides,
  };
}

test("POST: missing ZAPIER_LEAD_WEBHOOK_SECRET fails closed (500), no crash", async () => {
  await withEnv({ ZAPIER_LEAD_WEBHOOK_SECRET: undefined }, async () => {
    const req = new Request(URL, {
      method: "POST",
      headers: { authorization: "Bearer anything", "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    const res = await POST(req);
    assert.equal(res.status, 500);
    const json = await res.json();
    assert.equal(json.success, false);
  });
});

test("POST: missing Authorization header is rejected (401) before the body is touched", async () => {
  await withEnv({ ZAPIER_LEAD_WEBHOOK_SECRET: SECRET }, async () => {
    const req = new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not even valid json",
    });
    const res = await POST(req);
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.success, false);
  });
});

test("POST: wrong secret is rejected (401)", async () => {
  await withEnv({ ZAPIER_LEAD_WEBHOOK_SECRET: SECRET }, async () => {
    const req = new Request(URL, {
      method: "POST",
      headers: { authorization: "Bearer wrong-secret", "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    const res = await POST(req);
    assert.equal(res.status, 401);
  });
});

test("POST: invalid JSON body with a correct secret is rejected (400)", async () => {
  await withEnv({ ZAPIER_LEAD_WEBHOOK_SECRET: SECRET }, async () => {
    const req = new Request(URL, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: "{not valid json",
    });
    const res = await POST(req);
    assert.equal(res.status, 400);
  });
});

test("POST: valid secret but missing required fields is rejected (400) with field-level detail", async () => {
  await withEnv({ ZAPIER_LEAD_WEBHOOK_SECRET: SECRET }, async () => {
    const req = new Request(URL, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ source: "Facebook Lead Ads" }),
    });
    const res = await POST(req);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.ok(Array.isArray(json.details));
    assert.ok(json.details.length > 0);
  });
});

test("POST: an array-wrapped body is rejected (400) — guards Wrap Request In Array misconfiguration", async () => {
  await withEnv({ ZAPIER_LEAD_WEBHOOK_SECRET: SECRET }, async () => {
    const req = new Request(URL, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify([validBody()]),
    });
    const res = await POST(req);
    assert.equal(res.status, 400);
  });
});
