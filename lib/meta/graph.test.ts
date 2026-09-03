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
