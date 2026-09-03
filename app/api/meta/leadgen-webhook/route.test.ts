// Tests the route's own request-handling logic (verification-token
// check, signature verification, safe-ignore of non-leadgen payloads)
// by calling the exported GET/POST handlers directly with real Request
// objects — no running server needed, and no live Meta/Supabase secrets
// needed for these specific paths, since they all return before ever
// touching Supabase or the Meta API. Deeper ingestion behavior
// (matching/idempotency/etc.) is covered by lib/meta/ingest.test.ts
// against the shared, DI-friendly processOneLeadgenId — this file only
// covers what's specific to the HTTP layer itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { GET, POST } from "./route.ts";

const WEBHOOK_URL = "http://localhost/api/meta/leadgen-webhook";

// NOTE: fn is async — the restore in `finally` must happen AFTER its
// returned promise settles, not after fn() merely returns a pending
// promise. Awaiting inside this async function (rather than a bare
// `return fn()`) is what makes that ordering correct.
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

test("GET: missing META_WEBHOOK_VERIFY_TOKEN fails closed (500), no crash", async () => {
  await withEnv({ META_WEBHOOK_VERIFY_TOKEN: undefined }, async () => {
    const req = new Request(
      `${WEBHOOK_URL}?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=xyz`
    );
    const res = await GET(req);
    assert.equal(res.status, 500);
  });
});

test("GET: correct mode + verify_token echoes the challenge", async () => {
  await withEnv({ META_WEBHOOK_VERIFY_TOKEN: "correct-token" }, async () => {
    const req = new Request(
      `${WEBHOOK_URL}?hub.mode=subscribe&hub.verify_token=correct-token&hub.challenge=xyz123`
    );
    const res = await GET(req);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "xyz123");
  });
});

test("GET: wrong verify_token is rejected (403), challenge never echoed", async () => {
  await withEnv({ META_WEBHOOK_VERIFY_TOKEN: "correct-token" }, async () => {
    const req = new Request(
      `${WEBHOOK_URL}?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=xyz123`
    );
    const res = await GET(req);
    assert.equal(res.status, 403);
    const body = await res.text();
    assert.ok(!body.includes("xyz123"));
  });
});

test("GET: wrong mode is rejected even with the correct token", async () => {
  await withEnv({ META_WEBHOOK_VERIFY_TOKEN: "correct-token" }, async () => {
    const req = new Request(
      `${WEBHOOK_URL}?hub.mode=unsubscribe&hub.verify_token=correct-token&hub.challenge=xyz123`
    );
    const res = await GET(req);
    assert.equal(res.status, 403);
  });
});

test("POST: missing META_APP_SECRET fails closed (500), no crash", async () => {
  await withEnv({ META_APP_SECRET: undefined }, async () => {
    const req = new Request(WEBHOOK_URL, {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=deadbeef" },
      body: "{}",
    });
    const res = await POST(req);
    assert.equal(res.status, 500);
  });
});

test("POST: invalid signature is rejected (401) before the body is ever parsed", async () => {
  await withEnv({ META_APP_SECRET: "test-secret" }, async () => {
    const req = new Request(WEBHOOK_URL, {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64) },
      body: JSON.stringify({ object: "page", entry: [] }),
    });
    const res = await POST(req);
    assert.equal(res.status, 401);
  });
});

test("POST: missing signature header is rejected (401)", async () => {
  await withEnv({ META_APP_SECRET: "test-secret" }, async () => {
    const req = new Request(WEBHOOK_URL, {
      method: "POST",
      body: JSON.stringify({ object: "page", entry: [] }),
    });
    const res = await POST(req);
    assert.equal(res.status, 401);
  });
});

test("POST: valid signature but non-leadgen payload is safely acknowledged with zero processing (no Meta/Supabase secrets needed)", async () => {
  await withEnv({ META_APP_SECRET: "test-secret" }, async () => {
    const body = JSON.stringify({ object: "page", entry: [{ id: "p1", changes: [{ field: "feed", value: {} }] }] });
    const signature =
      "sha256=" + createHmac("sha256", "test-secret").update(body, "utf8").digest("hex");
    const req = new Request(WEBHOOK_URL, {
      method: "POST",
      headers: { "x-hub-signature-256": signature },
      body,
    });
    const res = await POST(req);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.processed, 0);
  });
});

test("POST: invalid JSON body (even if 'signed') is rejected (400)", async () => {
  await withEnv({ META_APP_SECRET: "test-secret" }, async () => {
    const body = "{not valid json";
    const signature =
      "sha256=" + createHmac("sha256", "test-secret").update(body, "utf8").digest("hex");
    const req = new Request(WEBHOOK_URL, {
      method: "POST",
      headers: { "x-hub-signature-256": signature },
      body,
    });
    const res = await POST(req);
    assert.equal(res.status, 400);
  });
});
