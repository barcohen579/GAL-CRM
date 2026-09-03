import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { GET } from "./route.ts";

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

test("health: reports ready=true (200) when CRON_SECRET is present", async () => {
  await withEnv({ CRON_SECRET: "x" }, async () => {
    const res = await GET();
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ready, true);
    assert.equal(json.checks.cronSecretConfigured, true);
  });
});

test("health: reports ready=false (503) when CRON_SECRET is missing", async () => {
  await withEnv({ CRON_SECRET: undefined }, async () => {
    const res = await GET();
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.equal(json.ready, false);
  });
});

test("health: never echoes an actual configured value back", async () => {
  const secretValue = "super-secret-value-must-never-appear-in-response";
  await withEnv({ CRON_SECRET: secretValue }, async () => {
    const res = await GET();
    const text = await res.text();
    assert.ok(!text.includes(secretValue));
  });
});

test("health route source never calls console.* and never queries Supabase", () => {
  const source = fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.ok(!/console\.\w+\(/.test(source));
  assert.ok(!/createClient|\.from\(|\.rpc\(/.test(source), "must not construct or use a Supabase client");
});
