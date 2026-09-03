import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  fetchWithTimeout,
  fetchLeadByLeadgenId,
  makePageAccessTokenDeriver,
  META_REQUEST_TIMEOUT_MS,
} from "./graph.ts";

function withMockedFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("fetchWithTimeout: aborts and throws a clear message after META_REQUEST_TIMEOUT_MS, never a never-ending hang", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  await withMockedFetch(
    // A fetch that never resolves on its own — only the timeout's abort
    // should ever settle this call.
    ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch,
    async () => {
      const pending = fetchWithTimeout("https://graph.facebook.com/v21.0/never-resolves");
      const assertion = assert.rejects(pending, /timed out after 10000ms/);
      t.mock.timers.tick(META_REQUEST_TIMEOUT_MS);
      await assertion;
    }
  );
});

test("fetchWithTimeout: a genuine non-abort fetch error still propagates as-is", async () => {
  await withMockedFetch(
    (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch,
    async () => {
      await assert.rejects(fetchWithTimeout("https://graph.facebook.com/v21.0/x"), /network down/);
    }
  );
});

const REAL_TOKEN = "EAABsomeRealisticLookingTokenValueThatMustNeverAppearAnywhere";

test("metaGet error messages never include the bearer token, even on failure", async () => {
  await withMockedFetch(
    (async () =>
      new Response(
        JSON.stringify({ error: { type: "OAuthException", code: 190, message: "Invalid OAuth access token." } }),
        { status: 401 }
      )) as unknown as typeof fetch,
    async () => {
      await assert.rejects(
        fetchLeadByLeadgenId("some-leadgen-id", REAL_TOKEN),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(!err.message.includes(REAL_TOKEN), "token must never appear in a thrown error message");
          assert.ok(err.message.includes("OAuthException"));
          return true;
        }
      );
    }
  );
});

test("makePageAccessTokenDeriver: no page found produces a clear error without leaking the token", async () => {
  await withMockedFetch(
    (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch,
    async () => {
      const derive = makePageAccessTokenDeriver(REAL_TOKEN);
      await assert.rejects(derive("some-page-id"), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!err.message.includes(REAL_TOKEN));
        return true;
      });
    }
  );
});

test("graph.ts source never calls console.* (field_data/PII must never be logged from this module)", () => {
  const source = fs.readFileSync(new URL("./graph.ts", import.meta.url), "utf8");
  assert.ok(!/console\.\w+\(/.test(source), "lib/meta/graph.ts must not log anything itself");
});

// Regression coverage for the Phase 3D production incident: the
// Lead-detail node (/{leadgen_id}) uses "adset_id" — NOT "adgroup_id",
// which is a different Meta API surface (the webhook notification
// payload; see lib/meta/webhook-payload.ts and its own tests).
// Requesting "adgroup_id" here fails the ENTIRE Graph API call
// (HTTP 400 / OAuthException 100), confirmed live in production
// against a real lead before this fix.

test("fetchLeadByLeadgenId: requests adset_id, never adgroup_id, in the Graph API fields param", async () => {
  let requestedUrl: string | null = null;
  await withMockedFetch(
    (async (url: string) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ id: "lead1", field_data: [] }), { status: 200 });
    }) as unknown as typeof fetch,
    async () => {
      await fetchLeadByLeadgenId("lead1", "fake-page-token");
    }
  );

  assert.ok(requestedUrl, "a request was made");
  const fields = new URL(requestedUrl!).searchParams.get("fields") ?? "";
  assert.ok(fields.includes("adset_id"), `fields must request adset_id — got: ${fields}`);
  assert.ok(!fields.includes("adgroup_id"), `fields must NOT request adgroup_id — got: ${fields}`);
});

test("fetchLeadByLeadgenId: maps the Lead-detail response's adset_id to internal adsetId", async () => {
  const record = await withMockedFetch(
    (async () =>
      new Response(
        JSON.stringify({
          id: "lead1",
          created_time: "2026-01-01T00:00:00+0000",
          ad_id: "ad1",
          adset_id: "the-real-adset-id",
          campaign_id: "camp1",
          form_id: "form1",
          field_data: [],
        }),
        { status: 200 }
      )) as unknown as typeof fetch,
    async () => fetchLeadByLeadgenId("lead1", "fake-page-token")
  );

  assert.equal(record.adsetId, "the-real-adset-id");
});

test("fetchLeadByLeadgenId: a stray adgroup_id in the response body is ignored, not mistaken for adsetId", async () => {
  // Defends against silently reverting the fix: even if some future
  // response happened to include an "adgroup_id" key, it must never be
  // read as the ad set id on this node.
  const record = await withMockedFetch(
    (async () =>
      new Response(
        JSON.stringify({ id: "lead1", adgroup_id: "should-be-ignored", field_data: [] }),
        { status: 200 }
      )) as unknown as typeof fetch,
    async () => fetchLeadByLeadgenId("lead1", "fake-page-token")
  );

  assert.equal(record.adsetId, null);
});
