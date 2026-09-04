// Tests the route's own HTTP-layer auth logic (missing/invalid
// CRON_SECRET) by calling the exported GET handler directly with a
// real Request — no live Supabase credentials and no real email
// provider call needed for these paths, since they all return before
// ever touching Supabase (see the other two cron routes' own
// route.test.ts for the same established pattern). The actual
// reminder-eligibility/retry rules are covered by
// lib/notifications/reminder-logic.test.ts (pure, no I/O); the
// claim/idempotency DB architecture is covered by
// supabase/tests/follow_up_notifications.test.sql against the real
// schema; email content is covered by lib/notifications/templates.test.ts.
// Per this task's explicit safety requirement, NO automated test here
// ever calls the real Resend API or sends a real email.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GET } from "./route.ts";

const CRON_URL = "http://localhost/api/cron/follow-up-notifications";

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

test("GET: missing CRON_SECRET fails closed (500), never accepts any caller", async () => {
  await withEnv({ CRON_SECRET: undefined }, async () => {
    const req = new Request(CRON_URL, {
      headers: { authorization: "Bearer anything" },
    });
    const res = await GET(req);
    assert.equal(res.status, 500);
  });
});

test("GET: no Authorization header is rejected (401) before touching Supabase or sending any email", async () => {
  await withEnv({ CRON_SECRET: "test-cron-secret" }, async () => {
    const req = new Request(CRON_URL);
    const res = await GET(req);
    assert.equal(res.status, 401);
  });
});

test("GET: wrong secret is rejected (401)", async () => {
  await withEnv({ CRON_SECRET: "test-cron-secret" }, async () => {
    const req = new Request(CRON_URL, {
      headers: { authorization: "Bearer wrong-secret" },
    });
    const res = await GET(req);
    assert.equal(res.status, 401);
  });
});

test("GET: a plain unauthenticated request (as any random internet caller would send) is rejected, not silently processed", async () => {
  await withEnv({ CRON_SECRET: "test-cron-secret" }, async () => {
    const req = new Request(CRON_URL, { method: "GET" });
    const res = await GET(req);
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.ok(!text.toLowerCase().includes("sent"));
  });
});
