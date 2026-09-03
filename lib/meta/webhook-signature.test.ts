import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyMetaWebhookSignature } from "./webhook-signature.ts";

const APP_SECRET = "test-app-secret-not-real";

function sign(body: string, secret = APP_SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

test("verifyMetaWebhookSignature: accepts a correctly signed body", () => {
  const body = JSON.stringify({ object: "page", entry: [] });
  assert.equal(verifyMetaWebhookSignature(body, sign(body), APP_SECRET), true);
});

test("verifyMetaWebhookSignature: rejects a body signed with the wrong secret", () => {
  const body = JSON.stringify({ object: "page", entry: [] });
  assert.equal(
    verifyMetaWebhookSignature(body, sign(body, "a-different-secret"), APP_SECRET),
    false
  );
});

test("verifyMetaWebhookSignature: rejects a tampered body (signature no longer matches)", () => {
  const original = JSON.stringify({ object: "page", entry: [] });
  const tampered = JSON.stringify({ object: "page", entry: [{ injected: true }] });
  assert.equal(verifyMetaWebhookSignature(tampered, sign(original), APP_SECRET), false);
});

test("verifyMetaWebhookSignature: rejects missing header", () => {
  assert.equal(verifyMetaWebhookSignature("{}", null, APP_SECRET), false);
  assert.equal(verifyMetaWebhookSignature("{}", undefined, APP_SECRET), false);
});

test("verifyMetaWebhookSignature: rejects malformed header (wrong prefix / non-hex)", () => {
  assert.equal(verifyMetaWebhookSignature("{}", "sha1=deadbeef", APP_SECRET), false);
  assert.equal(verifyMetaWebhookSignature("{}", "sha256=not-hex-zzz", APP_SECRET), false);
  assert.equal(verifyMetaWebhookSignature("{}", "sha256=", APP_SECRET), false);
});
