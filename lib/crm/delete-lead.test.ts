import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDeleteLeadError, BLOCKED_HAS_HISTORY_SQLSTATE } from "./delete-lead.ts";

test("classifyDeleteLeadError: no error -> null (success)", () => {
  assert.equal(classifyDeleteLeadError(null), null);
});

test("classifyDeleteLeadError: the customer/purchase-history block (GALB1) gets a specific, reassuring Hebrew message", () => {
  const message = classifyDeleteLeadError({
    code: BLOCKED_HAS_HISTORY_SQLSTATE,
    message: "Cannot delete this lead: the associated contact has customer/purchase history that must be preserved.",
  });
  assert.ok(message);
  assert.ok(message.includes("לקוחה"));
  assert.ok(message.includes("היסטוריית רכישות"));
  // Must not just be the raw English DB message re-shown verbatim —
  // this is the one case with a purpose-built Hebrew explanation.
  assert.ok(!message.includes("Cannot delete this lead"));
});

test("classifyDeleteLeadError: any other error gets the generic Hebrew-wrapped message, English detail included", () => {
  const message = classifyDeleteLeadError({
    code: "P0001",
    message: "Lead not found or not accessible",
  });
  assert.ok(message);
  assert.ok(message.startsWith("לא הצלחנו למחוק את הליד:"));
  assert.ok(message.includes("Lead not found or not accessible"));
});

test("classifyDeleteLeadError: an error with no code still gets the generic wrapped message (never crashes)", () => {
  const message = classifyDeleteLeadError({ message: "network error" });
  assert.ok(message);
  assert.ok(message.includes("network error"));
});
