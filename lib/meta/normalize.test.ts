import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, normalizeEmail } from "./normalize.ts";

test("normalizePhone: Israeli local format gets a 972 prefix", () => {
  assert.equal(normalizePhone("050-123-4567"), "972501234567");
  assert.equal(normalizePhone("0501234567"), "972501234567");
});

test("normalizePhone: already-E.164 forms normalize identically to local form", () => {
  assert.equal(normalizePhone("+972501234567"), "972501234567");
  assert.equal(normalizePhone("972501234567"), "972501234567");
  assert.equal(normalizePhone("050-123-4567"), normalizePhone("+972 50 123 4567"));
});

test("normalizePhone: strips an accidental extra leading 0 after 972", () => {
  assert.equal(normalizePhone("9720501234567"), "972501234567");
});

test("normalizePhone: does not force a country code onto a non-Israeli number", () => {
  assert.equal(normalizePhone("+1 415 555 0132"), "14155550132");
});

test("normalizePhone: rejects too-short input as unusable, not a false match", () => {
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone(undefined), null);
});

test("normalizeEmail: trims and lowercases", () => {
  assert.equal(normalizeEmail("  Someone@Example.com "), "someone@example.com");
});

test("normalizeEmail: rejects malformed input", () => {
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeEmail(""), null);
  assert.equal(normalizeEmail(null), null);
});
