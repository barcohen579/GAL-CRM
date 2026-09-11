// Tests the route's own auth-gating HTTP behavior by calling the
// exported POST handler directly with real Request objects — no running
// server, no live Supabase/Meta secrets needed, since every case here
// returns 401 before ever constructing the admin client or touching
// Supabase/Meta. (getCrmUser()-style session checks fail closed to
// "unauthenticated" when called outside a real Next.js request scope —
// see lib/supabase/get-crm-user.ts's own "fail closed, never open"
// comment — which is exactly what makes the "no session, no cron
// secret" case deterministically testable here.) Deeper sync/lock logic
// is covered by lib/meta/sync-orchestrator.test.ts against injected
// fakes; this file only covers what's specific to the HTTP layer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "./route.ts";

const TRIGGER_URL = "http://localhost/api/meta/sync-trigger";

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
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

test("POST: no Authorization header, no session -> 401", async () => {
  await withEnv({ CRON_SECRET: "test-cron-secret" }, async () => {
    const req = new Request(TRIGGER_URL, { method: "POST" });
    const res = await POST(req);
    assert.equal(res.status, 401);
  });
});

test("POST: wrong bearer token, no session -> 401", async () => {
  await withEnv({ CRON_SECRET: "test-cron-secret" }, async () => {
    const req = new Request(TRIGGER_URL, {
      method: "POST",
      headers: { authorization: "Bearer totally-wrong-secret" },
    });
    const res = await POST(req);
    assert.equal(res.status, 401);
  });
});

test("POST: CRON_SECRET not configured at all, no session -> 401 (never a 500 for this)", async () => {
  await withEnv({ CRON_SECRET: undefined }, async () => {
    const req = new Request(TRIGGER_URL, {
      method: "POST",
      headers: { authorization: "Bearer anything" },
    });
    const res = await POST(req);
    assert.equal(res.status, 401);
  });
});

test("POST: response body never contains account ids, tokens, or raw error text on the auth-rejection path", async () => {
  await withEnv({ CRON_SECRET: "test-cron-secret" }, async () => {
    const req = new Request(TRIGGER_URL, { method: "POST" });
    const res = await POST(req);
    const text = await res.text();
    assert.ok(!text.includes("act_"), "must never leak an ad account id");
    assert.ok(!text.includes("test-cron-secret"), "must never leak the configured secret");
  });
});
