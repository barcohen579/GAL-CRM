import { test } from "node:test";
import assert from "node:assert/strict";
import { findMatchingContactId } from "./contact-matching.ts";

const candidates = [
  { id: "c1", phone: "0501234567", email: null },
  { id: "c2", phone: null, email: "shira@example.com" },
  { id: "c3", phone: "0509999999", email: "other@example.com" },
];

test("findMatchingContactId: matches by normalized phone first, even with different formatting", () => {
  assert.equal(findMatchingContactId(candidates, "+972 50 123 4567", null), "c1");
});

test("findMatchingContactId: falls back to normalized email when phone doesn't match", () => {
  assert.equal(findMatchingContactId(candidates, null, "Shira@Example.com"), "c2");
});

test("findMatchingContactId: phone match wins over an email match on a different candidate", () => {
  assert.equal(findMatchingContactId(candidates, "0501234567", "other@example.com"), "c1");
});

test("findMatchingContactId: no match -> null (never fuzzy-matches by name — this function never even sees a name)", () => {
  assert.equal(findMatchingContactId(candidates, "0500000001", "nobody@example.com"), null);
});

test("findMatchingContactId: no phone/email given at all -> null", () => {
  assert.equal(findMatchingContactId(candidates, null, null), null);
});

test("findMatchingContactId: empty candidate list -> null", () => {
  assert.equal(findMatchingContactId([], "0501234567", "shira@example.com"), null);
});
