import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGeneralPaymentInput, parseManualPaymentInput, validatePurchaseOwnership } from "./payments.ts";

function validFields(overrides: Partial<Parameters<typeof parseManualPaymentInput>[0]> = {}) {
  return {
    purchaseId: "purchase-1",
    customerId: "customer-1",
    amountRaw: "350",
    paidAt: "2026-09-11",
    method: "CASH",
    status: null,
    notes: null,
    ...overrides,
  };
}

test("parseManualPaymentInput: a valid Customer + Purchase submission parses correctly, amount/date/method persist as given", () => {
  const parsed = parseManualPaymentInput(validFields());
  assert.ok(!("error" in parsed));
  if ("error" in parsed) return;
  assert.equal(parsed.purchaseId, "purchase-1");
  assert.equal(parsed.customerId, "customer-1");
  assert.equal(parsed.amountMinor, 35000); // ₪350 -> integer agorot
  assert.equal(parsed.paidAt, "2026-09-11");
  assert.equal(parsed.method, "CASH");
  assert.equal(parsed.status, "PAID"); // defaults to PAID when omitted -- real revenue
  assert.equal(parsed.notes, null);
});

test("parseManualPaymentInput: an explicit status overrides the PAID default", () => {
  const parsed = parseManualPaymentInput(validFields({ status: "REFUNDED" }));
  assert.ok(!("error" in parsed));
  if ("error" in parsed) return;
  assert.equal(parsed.status, "REFUNDED");
});

test("parseManualPaymentInput: an optional note is preserved when the model supports it", () => {
  const parsed = parseManualPaymentInput(validFields({ notes: "שולם במזומן אצל גל" }));
  assert.ok(!("error" in parsed));
  if ("error" in parsed) return;
  assert.equal(parsed.notes, "שולם במזומן אצל גל");
});

test("parseManualPaymentInput: missing purchase is rejected in Hebrew", () => {
  const parsed = parseManualPaymentInput(validFields({ purchaseId: null }));
  assert.ok("error" in parsed);
});

test("parseManualPaymentInput: missing amount is rejected", () => {
  const parsed = parseManualPaymentInput(validFields({ amountRaw: null }));
  assert.ok("error" in parsed);
});

test("parseManualPaymentInput: a negative or non-numeric amount is rejected", () => {
  assert.ok("error" in parseManualPaymentInput(validFields({ amountRaw: "-50" })));
  assert.ok("error" in parseManualPaymentInput(validFields({ amountRaw: "abc" })));
});

test("parseManualPaymentInput: amount handles thousands separators (e.g. '1,500')", () => {
  const parsed = parseManualPaymentInput(validFields({ amountRaw: "1,500" }));
  assert.ok(!("error" in parsed));
  if ("error" in parsed) return;
  assert.equal(parsed.amountMinor, 150000);
});

test("parseManualPaymentInput: missing paid_at is rejected", () => {
  assert.ok("error" in parseManualPaymentInput(validFields({ paidAt: null })));
});

test("parseManualPaymentInput: missing method is rejected", () => {
  assert.ok("error" in parseManualPaymentInput(validFields({ method: null })));
});

test("validatePurchaseOwnership: a Purchase genuinely owned by the selected Customer is accepted", () => {
  const result = validatePurchaseOwnership({ customer_id: "customer-1" }, "customer-1");
  assert.equal(result.ok, true);
});

test("validatePurchaseOwnership: a Purchase belonging to a DIFFERENT customer is rejected", () => {
  const result = validatePurchaseOwnership({ customer_id: "customer-2" }, "customer-1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /אינה שייכת/);
});

test("validatePurchaseOwnership: a Purchase that doesn't exist at all is rejected", () => {
  const result = validatePurchaseOwnership(null, "customer-1");
  assert.equal(result.ok, false);
});

test("validatePurchaseOwnership: no customerId supplied (e.g. legacy caller) does not itself reject an existing purchase", () => {
  const result = validatePurchaseOwnership({ customer_id: "customer-2" }, null);
  assert.equal(result.ok, true);
});

function validGeneralFields(overrides: Partial<Parameters<typeof parseGeneralPaymentInput>[0]> = {}) {
  return {
    amountRaw: "500",
    paidAt: "2026-09-11",
    method: "CASH",
    status: null,
    notes: "הכנסה מאירוע",
    ...overrides,
  };
}

test("parseGeneralPaymentInput: a valid general payment (no Customer/Purchase needed) parses correctly", () => {
  const parsed = parseGeneralPaymentInput(validGeneralFields());
  assert.ok(!("error" in parsed));
  if ("error" in parsed) return;
  assert.equal(parsed.amountMinor, 50000);
  assert.equal(parsed.paidAt, "2026-09-11");
  assert.equal(parsed.method, "CASH");
  assert.equal(parsed.status, "PAID");
  assert.equal(parsed.notes, "הכנסה מאירוע");
});

test("parseGeneralPaymentInput: a missing description is rejected", () => {
  assert.ok("error" in parseGeneralPaymentInput(validGeneralFields({ notes: null })));
});

test("parseGeneralPaymentInput: a description that's only whitespace is rejected (not just 'missing')", () => {
  assert.ok("error" in parseGeneralPaymentInput(validGeneralFields({ notes: "   " })));
});

test("parseGeneralPaymentInput: missing amount is rejected", () => {
  assert.ok("error" in parseGeneralPaymentInput(validGeneralFields({ amountRaw: null })));
});

test("parseGeneralPaymentInput: missing paid_at is rejected", () => {
  assert.ok("error" in parseGeneralPaymentInput(validGeneralFields({ paidAt: null })));
});

test("parseGeneralPaymentInput: missing method is rejected", () => {
  assert.ok("error" in parseGeneralPaymentInput(validGeneralFields({ method: null })));
});

test("parseGeneralPaymentInput: an explicit status overrides the PAID default", () => {
  const parsed = parseGeneralPaymentInput(validGeneralFields({ status: "REFUNDED" }));
  assert.ok(!("error" in parsed));
  if ("error" in parsed) return;
  assert.equal(parsed.status, "REFUNDED");
});
