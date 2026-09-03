// Regression test for a Phase 3C audit finding: this middleware was
// redirecting EVERY /api/* request (including the Meta webhook, which
// carries no Supabase session cookie) to /login, before ever reaching
// the actual route handler — which would have silently broken the
// entire webhook integration in production. Confirmed live via a real
// `next dev` request before this fix existed; this test pins the fix
// so it can never silently regress.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import { updateSession } from "./middleware.ts";

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

test("updateSession: /api/meta/leadgen-webhook is never redirected, even with zero Supabase config", async () => {
  await withEnv(
    { NEXT_PUBLIC_SUPABASE_URL: undefined, NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined },
    async () => {
      const request = new NextRequest("http://localhost/api/meta/leadgen-webhook");
      const response = await updateSession(request);
      assert.equal(response.status, 200, "no redirect status");
      assert.equal(response.headers.get("location"), null, "no Location header at all");
    }
  );
});

test("updateSession: /api/meta/leadgen-webhook/health is never redirected", async () => {
  await withEnv(
    { NEXT_PUBLIC_SUPABASE_URL: undefined, NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined },
    async () => {
      const request = new NextRequest("http://localhost/api/meta/leadgen-webhook/health");
      const response = await updateSession(request);
      assert.equal(response.headers.get("location"), null);
    }
  );
});

test("updateSession: a protected PAGE (e.g. /dashboard) still redirects to /login when unauthenticated — the fix did not weaken page protection", async () => {
  await withEnv(
    { NEXT_PUBLIC_SUPABASE_URL: undefined, NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined },
    async () => {
      const request = new NextRequest("http://localhost/dashboard");
      const response = await updateSession(request);
      assert.equal(response.status, 307);
      assert.ok(response.headers.get("location")?.endsWith("/login"));
    }
  );
});

test("updateSession: /login itself is never redirected", async () => {
  await withEnv(
    { NEXT_PUBLIC_SUPABASE_URL: undefined, NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined },
    async () => {
      const request = new NextRequest("http://localhost/login");
      const response = await updateSession(request);
      assert.equal(response.headers.get("location"), null);
    }
  );
});
