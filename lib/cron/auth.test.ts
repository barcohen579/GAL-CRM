import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyCronAuthHeader } from "./auth.ts";

const SECRET = "test-cron-secret-value-1234567890";

test("verifyCronAuthHeader: accepts a correctly-formed Bearer header matching the secret", () => {
  assert.equal(verifyCronAuthHeader(`Bearer ${SECRET}`, SECRET), true);
});

test("verifyCronAuthHeader: rejects a wrong secret", () => {
  assert.equal(verifyCronAuthHeader("Bearer wrong-secret", SECRET), false);
});

test("verifyCronAuthHeader: rejects a missing header", () => {
  assert.equal(verifyCronAuthHeader(null, SECRET), false);
  assert.equal(verifyCronAuthHeader(undefined, SECRET), false);
});

test("verifyCronAuthHeader: rejects a header without the Bearer prefix", () => {
  assert.equal(verifyCronAuthHeader(SECRET, SECRET), false);
});

test("verifyCronAuthHeader: rejects an empty Bearer token", () => {
  assert.equal(verifyCronAuthHeader("Bearer ", SECRET), false);
});

test("verifyCronAuthHeader: rejects a token that is a prefix of the real secret (no partial match)", () => {
  assert.equal(verifyCronAuthHeader(`Bearer ${SECRET.slice(0, 10)}`, SECRET), false);
});

test("verifyCronAuthHeader: is case-sensitive on the token itself", () => {
  assert.equal(verifyCronAuthHeader(`Bearer ${SECRET.toUpperCase()}`, SECRET), false);
});
