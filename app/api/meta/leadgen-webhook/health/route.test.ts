import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { GET } from "./route.ts";

const ALL_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "META_ACCESS_TOKEN",
  "META_APP_SECRET",
  "META_WEBHOOK_VERIFY_TOKEN",
] as const;

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

test("health: reports ready=true (200) when every required variable is present", async () => {
  const allSet = Object.fromEntries(ALL_VARS.map((k) => [k, "x"]));
  await withEnv(allSet, async () => {
    const res = await GET();
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ready, true);
    assert.ok(Object.values(json.checks).every((v) => v === true));
  });
});

test("health: reports ready=false (503) when any required variable is missing", async () => {
  const allSet = Object.fromEntries(ALL_VARS.map((k) => [k, "x"]));
  await withEnv({ ...allSet, META_APP_SECRET: undefined }, async () => {
    const res = await GET();
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.equal(json.ready, false);
    assert.equal(json.checks.metaAppSecretConfigured, false);
  });
});

test("health: never echoes an actual configured value back", async () => {
  const secretValue = "super-secret-value-must-never-appear-in-response";
  await withEnv({ META_APP_SECRET: secretValue }, async () => {
    const res = await GET();
    const text = await res.text();
    assert.ok(!text.includes(secretValue));
  });
});

test("health route source never calls console.* and never queries Supabase/Meta", () => {
  // Static regression guard: this endpoint's whole point is to be safe
  // to leave publicly reachable — it must stay a pure env-presence
  // check, never grow into something that logs or fetches on every hit.
  const source = fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.ok(!/console\.\w+\(/.test(source));
  assert.ok(!/^\s*import\b/m.test(source), "must not import any client library at all — pure env check");
  assert.ok(!/createClient|\.from\(/.test(source), "must not construct or use a Supabase client");
  assert.ok(!/fetch\(/.test(source), "must not make an outbound network call");
});
