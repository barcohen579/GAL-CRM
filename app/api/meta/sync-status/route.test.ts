// Tests the route's own auth-gating (see sync-trigger/route.test.ts's
// header comment for why "no session -> unauthenticated" is
// deterministically testable outside a real Next.js request scope,
// without a live Supabase connection).

import { test } from "node:test";
import assert from "node:assert/strict";
import { GET } from "./route.ts";

test("GET: no session -> 401", async () => {
  const res = await GET();
  assert.equal(res.status, 401);
});

test("GET: unauthenticated response body leaks nothing sync-related", async () => {
  const res = await GET();
  const text = await res.text();
  assert.ok(!text.includes("last_success_at"));
});
