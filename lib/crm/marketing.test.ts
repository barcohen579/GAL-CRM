import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLeadAttribution } from "./marketing.ts";

// Referral-relevant coverage for classifyLeadAttribution. This module had
// no dedicated test file before the referral feature — these cases exist
// specifically to lock in the invariant the referral model depends on:
// a REFERRAL touchpoint must never be, or become, Meta attribution.
// (General campaign-aggregation / monthly-metrics coverage is out of
// scope here — those pre-date this change and aren't touched by it.)

test("classifyLeadAttribution: a REFERRAL-only touchpoint is NOT_META", () => {
  const result = classifyLeadAttribution([{ channel: "REFERRAL", certainty: "CONFIRMED" }]);
  assert.equal(result, "NOT_META");
});

test("classifyLeadAttribution: REFERRAL alongside other non-Meta channels is still NOT_META", () => {
  const result = classifyLeadAttribution([
    { channel: "REFERRAL", certainty: "CONFIRMED" },
    { channel: "WORD_OF_MOUTH", certainty: "BROAD" },
  ]);
  assert.equal(result, "NOT_META");
});

test("classifyLeadAttribution: a genuine CONFIRMED META_AD touchpoint is unaffected by an unrelated REFERRAL touchpoint on the same lead", () => {
  const result = classifyLeadAttribution([
    { channel: "META_AD", certainty: "CONFIRMED" },
    { channel: "REFERRAL", certainty: "CONFIRMED" },
  ]);
  assert.equal(result, "CONFIRMED_META");
});

test("classifyLeadAttribution: no touchpoints at all is NOT_META", () => {
  assert.equal(classifyLeadAttribution([]), "NOT_META");
});
