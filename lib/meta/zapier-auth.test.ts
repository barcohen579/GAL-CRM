import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyZapierAuthHeader } from "./zapier-auth.ts";

const SECRET = "test-zapier-secret-value-1234567890";

test("verifyZapierAuthHeader: accepts a correctly-formed Bearer header matching the secret", () => {
  assert.equal(verifyZapierAuthHeader(`Bearer ${SECRET}`, SECRET), true);
});

test("verifyZapierAuthHeader: rejects a wrong secret", () => {
  assert.equal(verifyZapierAuthHeader("Bearer wrong-secret", SECRET), false);
});

test("verifyZapierAuthHeader: rejects a missing header", () => {
  assert.equal(verifyZapierAuthHeader(null, SECRET), false);
  assert.equal(verifyZapierAuthHeader(undefined, SECRET), false);
});

test("verifyZapierAuthHeader: rejects a header without the Bearer prefix", () => {
  assert.equal(verifyZapierAuthHeader(SECRET, SECRET), false);
});

test("verifyZapierAuthHeader: rejects an empty Bearer token", () => {
  assert.equal(verifyZapierAuthHeader("Bearer ", SECRET), false);
});

test("verifyZapierAuthHeader: rejects a token that is a prefix of the real secret (no partial match)", () => {
  assert.equal(verifyZapierAuthHeader(`Bearer ${SECRET.slice(0, 10)}`, SECRET), false);
});

test("verifyZapierAuthHeader: is case-sensitive on the token itself", () => {
  assert.equal(verifyZapierAuthHeader(`Bearer ${SECRET.toUpperCase()}`, SECRET), false);
});
