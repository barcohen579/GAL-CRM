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

// Phase 3C audit: the exact equivalence class named in the audit
// request — 05XXXXXXXX / +9725XXXXXXXX / 9725XXXXXXXX / spaces /
// hyphens must all normalize to the SAME value for the SAME number.
test("normalizePhone: 05XXXXXXXX, +9725XXXXXXXX, 9725XXXXXXXX, spaced and hyphenated forms all normalize identically", () => {
  const forms = [
    "0521234567",
    "+972521234567",
    "972521234567",
    "+972 52 123 4567",
    "052-123-4567",
    "052 123 4567",
    "+972-52-123-4567",
  ];
  const normalized = forms.map((f) => normalizePhone(f));
  for (const n of normalized) assert.equal(n, "972521234567");
});

test("normalizePhone: does not merge two genuinely different Israeli numbers", () => {
  assert.notEqual(normalizePhone("0521234567"), normalizePhone("0529999999"));
});

test("normalizePhone: does not merge two genuinely different non-Israeli international numbers", () => {
  assert.notEqual(normalizePhone("+1 415 555 0132"), normalizePhone("+44 20 7946 0958"));
  assert.equal(normalizePhone("+44 20 7946 0958"), "442079460958");
});

test("normalizeEmail: trims and lowercases", () => {
  assert.equal(normalizeEmail("  Someone@Example.com "), "someone@example.com");
});

test("normalizeEmail: performs no provider-specific rewriting (e.g. no Gmail dot/plus stripping)", () => {
  // Deliberately conservative: 'a.b@gmail.com' and 'ab@gmail.com' are
  // the same Gmail inbox in reality, but this normalizer must NOT
  // encode that provider-specific knowledge — doing so risks merging
  // two different real contacts on a guess. trim+lowercase only.
  assert.equal(normalizeEmail("a.b@gmail.com"), "a.b@gmail.com");
  assert.notEqual(normalizeEmail("a.b@gmail.com"), normalizeEmail("ab@gmail.com"));
  assert.equal(normalizeEmail("user+tag@example.com"), "user+tag@example.com");
});

test("normalizeEmail: rejects malformed input", () => {
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeEmail(""), null);
  assert.equal(normalizeEmail(null), null);
});
