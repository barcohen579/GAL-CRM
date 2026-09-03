import { test } from "node:test";
import assert from "node:assert/strict";
import { computeReferralMetrics } from "./referrals.ts";

test("computeReferralMetrics: no referrals at all → all zeros", () => {
  const result = computeReferralMetrics([], []);
  assert.deepEqual(result, { referredCount: 0, becameCustomerCount: 0, revenueMinor: 0 });
});

test("computeReferralMetrics: referred contacts who never became customers count toward referredCount but not becameCustomerCount or revenue", () => {
  const referralsMade = [
    { referred_contact: { customers: null } }, // still just a Lead, or nothing at all
    { referred_contact: null }, // defensive: contact somehow missing from the embed
  ];
  const result = computeReferralMetrics(referralsMade, []);
  assert.equal(result.referredCount, 2);
  assert.equal(result.becameCustomerCount, 0);
  assert.equal(result.revenueMinor, 0);
});

test("computeReferralMetrics: referred count, became-customer count, and revenue computed correctly together", () => {
  const referralsMade = [
    { referred_contact: { customers: { id: "cust-1" } } },
    { referred_contact: { customers: { id: "cust-2" } } },
    { referred_contact: { customers: null } }, // referred a lead who never converted
  ];
  const referredPurchases = [
    { payments: [{ amount: 35000, status: "PAID" }, { amount: 5000, status: "REFUNDED" }] },
    { payments: [{ amount: 12000, status: "PAID" }] },
  ];
  const result = computeReferralMetrics(referralsMade, referredPurchases);
  assert.equal(result.referredCount, 3);
  assert.equal(result.becameCustomerCount, 2);
  // Only PAID payments count — the 5000 REFUNDED entry must be excluded.
  assert.equal(result.revenueMinor, 47000);
});

test("computeReferralMetrics: non-PAID payments (REFUNDED, FAILED) never contribute to revenue", () => {
  const referralsMade = [{ referred_contact: { customers: { id: "cust-1" } } }];
  const referredPurchases = [
    { payments: [{ amount: 10000, status: "REFUNDED" }, { amount: 20000, status: "FAILED" }] },
  ];
  const result = computeReferralMetrics(referralsMade, referredPurchases);
  assert.equal(result.revenueMinor, 0);
});

test("computeReferralMetrics: revenue is a flat sum across purchases and payments, not per-referral or per-customer bucketed", () => {
  const referralsMade = [{ referred_contact: { customers: { id: "cust-1" } } }];
  const referredPurchases = [
    { payments: [{ amount: 10000, status: "PAID" }] },
    { payments: [{ amount: 20000, status: "PAID" }, { amount: 5000, status: "PAID" }] },
  ];
  const result = computeReferralMetrics(referralsMade, referredPurchases);
  assert.equal(result.revenueMinor, 35000);
});
