import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateRevenueByService,
  aggregateLeadSources,
  buildMonthlySalesFunnel,
  buildMonthlyReferralMetrics,
  aggregateExpensesByCategory,
} from "./business-report.ts";
import { SERVICE_TYPES } from "./constants.ts";

// ------------------------------------------------------------------
// aggregateRevenueByService
// ------------------------------------------------------------------

test("aggregateRevenueByService: groups payments by their purchase's service_type", () => {
  const rows = aggregateRevenueByService([
    { amount: 350000, purchase: { service_type: "GROUP_TRAINING" } },
    { amount: 200000, purchase: { service_type: "GROUP_TRAINING" } },
    { amount: 170000, purchase: { service_type: "PERSONAL_TRAINING" } },
  ]);
  const groupRow = rows.find((r) => r.serviceType === "GROUP_TRAINING")!;
  const personalRow = rows.find((r) => r.serviceType === "PERSONAL_TRAINING")!;
  assert.equal(groupRow.amountMinor, 550000);
  assert.equal(personalRow.amountMinor, 170000);
});

test("aggregateRevenueByService: includes every service type, even ones with zero revenue", () => {
  const rows = aggregateRevenueByService([{ amount: 100, purchase: { service_type: "GROUP_TRAINING" } }]);
  for (const s of SERVICE_TYPES) {
    assert.ok(rows.some((r) => r.serviceType === s), `${s} must be present even with 0 revenue`);
  }
});

test("aggregateRevenueByService: reconciles exactly to the total of all input payments", () => {
  const payments = [
    { amount: 35000, purchase: { service_type: "GROUP_TRAINING" as const } },
    { amount: 24000, purchase: { service_type: "NUTRITION_COACHING" as const } },
    { amount: 17000, purchase: { service_type: "PERSONAL_TRAINING" as const } },
    { amount: 9900, purchase: { service_type: "MAMA_RESET" as const } },
  ];
  const rows = aggregateRevenueByService(payments);
  const total = rows.reduce((sum, r) => sum + r.amountMinor, 0);
  const expected = payments.reduce((sum, p) => sum + p.amount, 0);
  assert.equal(total, expected);
});

test("aggregateRevenueByService: an unclassifiable payment (no purchase) is bucketed as UNCLASSIFIED, never silently dropped", () => {
  const rows = aggregateRevenueByService([
    { amount: 10000, purchase: { service_type: "GROUP_TRAINING" } },
    { amount: 5000, purchase: null },
  ]);
  const total = rows.reduce((sum, r) => sum + r.amountMinor, 0);
  assert.equal(total, 15000, "the unclassifiable payment must still be counted somewhere");
  const unclassified = rows.find((r) => r.serviceType === "UNCLASSIFIED");
  assert.equal(unclassified?.amountMinor, 5000);
});

test("aggregateRevenueByService: no payments at all -> every row is 0, total is 0", () => {
  const rows = aggregateRevenueByService([]);
  assert.equal(rows.reduce((sum, r) => sum + r.amountMinor, 0), 0);
});

// ------------------------------------------------------------------
// aggregateLeadSources
// ------------------------------------------------------------------

test("aggregateLeadSources: a lead with a marked-primary touchpoint uses that channel", () => {
  const counts = aggregateLeadSources([
    {
      id: "l1",
      touchpoints: [
        { channel: "META_AD", certainty: "CONFIRMED", is_primary: false, created_at: "2026-09-01T10:00:00Z" },
        { channel: "REFERRAL", certainty: "CONFIRMED", is_primary: true, created_at: "2026-09-02T10:00:00Z" },
      ],
    },
  ]);
  assert.equal(counts.REFERRAL, 1);
  assert.equal(counts.META_AD, 0);
});

test("aggregateLeadSources: no primary marked -> falls back to the EARLIEST touchpoint by created_at", () => {
  const counts = aggregateLeadSources([
    {
      id: "l1",
      touchpoints: [
        { channel: "WEBSITE", certainty: "BROAD", is_primary: false, created_at: "2026-09-05T10:00:00Z" },
        { channel: "INSTAGRAM_DM", certainty: "BROAD", is_primary: false, created_at: "2026-09-01T08:00:00Z" },
      ],
    },
  ]);
  assert.equal(counts.INSTAGRAM_DM, 1);
  assert.equal(counts.WEBSITE, 0);
});

test("aggregateLeadSources: zero touchpoints -> UNKNOWN", () => {
  const counts = aggregateLeadSources([{ id: "l1", touchpoints: [] }]);
  assert.equal(counts.UNKNOWN, 1);
});

test("aggregateLeadSources: a lead with MULTIPLE touchpoints is counted exactly ONCE total, never once per touchpoint", () => {
  const counts = aggregateLeadSources([
    {
      id: "l1",
      touchpoints: [
        { channel: "META_AD", certainty: "BROAD", is_primary: false, created_at: "2026-09-01T10:00:00Z" },
        { channel: "INSTAGRAM_ORGANIC", certainty: "BROAD", is_primary: false, created_at: "2026-09-03T10:00:00Z" },
        { channel: "WORD_OF_MOUTH", certainty: "BROAD", is_primary: true, created_at: "2026-09-04T10:00:00Z" },
      ],
    },
  ]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(total, 1, "one lead must contribute exactly one unit across ALL channels combined");
  assert.equal(counts.WORD_OF_MOUTH, 1);
});

test("aggregateLeadSources: multiple leads each contribute independently", () => {
  const counts = aggregateLeadSources([
    { id: "l1", touchpoints: [{ channel: "META_AD", certainty: "CONFIRMED", is_primary: true, created_at: "2026-09-01T10:00:00Z" }] },
    { id: "l2", touchpoints: [{ channel: "META_AD", certainty: "CONFIRMED", is_primary: true, created_at: "2026-09-02T10:00:00Z" }] },
    { id: "l3", touchpoints: [] },
  ]);
  assert.equal(counts.META_AD, 2);
  assert.equal(counts.UNKNOWN, 1);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 3);
});

// ------------------------------------------------------------------
// buildMonthlySalesFunnel
// ------------------------------------------------------------------

test("buildMonthlySalesFunnel: conversion rate is won / (won + lost) among DECIDED leads, never won / newLeads", () => {
  const funnel = buildMonthlySalesFunnel({
    newLeadsCount: 50, // a different, unrelated cohort on purpose
    wonLeadIds: ["a", "b", "c"],
    lostLeadIds: ["d"],
    newCustomersCount: 3,
  });
  assert.equal(funnel.wonCount, 3);
  assert.equal(funnel.lostCount, 1);
  assert.equal(funnel.conversionRatePercent, 75); // 3 / (3+1)
  assert.notEqual(funnel.conversionRatePercent, (3 / 50) * 100, "must not divide across mismatched cohorts");
});

test("buildMonthlySalesFunnel: nothing decided this month -> null, never a fabricated 0%", () => {
  const funnel = buildMonthlySalesFunnel({
    newLeadsCount: 10,
    wonLeadIds: [],
    lostLeadIds: [],
    newCustomersCount: 0,
  });
  assert.equal(funnel.conversionRatePercent, null);
});

test("buildMonthlySalesFunnel: a duplicate lead id in wonLeadIds (e.g. two stage-events) is counted once", () => {
  const funnel = buildMonthlySalesFunnel({
    newLeadsCount: 0,
    wonLeadIds: ["a", "a"],
    lostLeadIds: [],
    newCustomersCount: 0,
  });
  assert.equal(funnel.wonCount, 1);
});

test("buildMonthlySalesFunnel: newCustomersCount is independent of wonCount (a direct customer with no Lead)", () => {
  const funnel = buildMonthlySalesFunnel({
    newLeadsCount: 0,
    wonLeadIds: [],
    lostLeadIds: [],
    newCustomersCount: 1, // e.g. via "הוספת לקוחה", no Lead ever existed
  });
  assert.equal(funnel.newCustomersCount, 1);
  assert.equal(funnel.wonCount, 0);
});

// ------------------------------------------------------------------
// buildMonthlyReferralMetrics
// ------------------------------------------------------------------

const monthKeyOf = (v: string) => v.slice(0, 7);

test("buildMonthlyReferralMetrics: referredCount is scoped to referrals created in the selected month", () => {
  const metrics = buildMonthlyReferralMetrics({
    allReferrals: [
      { created_at: "2026-09-05T00:00:00Z", referred_contact_id: "c1" },
      { created_at: "2026-08-01T00:00:00Z", referred_contact_id: "c2" }, // different month
    ],
    contactIdToCustomerId: new Map(),
    paymentsInMonth: [],
    monthKey: "2026-09",
    monthKeyOf,
  });
  assert.equal(metrics.referredCount, 1);
});

test("buildMonthlyReferralMetrics: becameCustomerCount only counts this month's referred cohort who now have a Customer row", () => {
  const metrics = buildMonthlyReferralMetrics({
    allReferrals: [
      { created_at: "2026-09-05T00:00:00Z", referred_contact_id: "c1" },
      { created_at: "2026-09-06T00:00:00Z", referred_contact_id: "c2" },
    ],
    contactIdToCustomerId: new Map([["c1", "cust1"]]), // c2 never became a customer
    paymentsInMonth: [],
    monthKey: "2026-09",
    monthKeyOf,
  });
  assert.equal(metrics.becameCustomerCount, 1);
});

test("buildMonthlyReferralMetrics: revenue counts a referred customer's payment THIS month even if the referral itself happened a different month", () => {
  const metrics = buildMonthlyReferralMetrics({
    allReferrals: [{ created_at: "2026-06-01T00:00:00Z", referred_contact_id: "c1" }], // referred in June
    contactIdToCustomerId: new Map([["c1", "cust1"]]),
    paymentsInMonth: [{ amount: 35000, customerId: "cust1" }], // paid in September (the selected month)
    monthKey: "2026-09",
    monthKeyOf,
  });
  assert.equal(metrics.revenueMinor, 35000, "direct referral revenue must not require same-month referral+payment");
});

test("buildMonthlyReferralMetrics: a non-referred customer's payment never counts toward referral revenue", () => {
  const metrics = buildMonthlyReferralMetrics({
    allReferrals: [{ created_at: "2026-09-01T00:00:00Z", referred_contact_id: "c1" }],
    contactIdToCustomerId: new Map([["c1", "cust1"]]),
    paymentsInMonth: [
      { amount: 35000, customerId: "cust1" }, // referred
      { amount: 90000, customerId: "cust-other" }, // NOT referred
    ],
    monthKey: "2026-09",
    monthKeyOf,
  });
  assert.equal(metrics.revenueMinor, 35000);
});

test("buildMonthlyReferralMetrics: no referrals at all -> all zeros, no crash", () => {
  const metrics = buildMonthlyReferralMetrics({
    allReferrals: [],
    contactIdToCustomerId: new Map(),
    paymentsInMonth: [{ amount: 1000, customerId: "cust1" }],
    monthKey: "2026-09",
    monthKeyOf,
  });
  assert.deepEqual(metrics, { referredCount: 0, becameCustomerCount: 0, revenueMinor: 0 });
});

// ------------------------------------------------------------------
// aggregateExpensesByCategory
// ------------------------------------------------------------------

test("aggregateExpensesByCategory: groups expenses by category", () => {
  const rows = aggregateExpensesByCategory([
    { amount_minor: 300000, category: "RENT" },
    { amount_minor: 25000, category: "EQUIPMENT" },
    { amount_minor: 5000, category: "EQUIPMENT" },
  ]);
  const rent = rows.find((r) => r.category === "RENT")!;
  const equipment = rows.find((r) => r.category === "EQUIPMENT")!;
  assert.equal(rent.amountMinor, 300000);
  assert.equal(equipment.amountMinor, 30000);
});

test("aggregateExpensesByCategory: sorted largest amount first", () => {
  const rows = aggregateExpensesByCategory([
    { amount_minor: 5000, category: "OTHER" },
    { amount_minor: 300000, category: "RENT" },
    { amount_minor: 25000, category: "SOFTWARE_SUBSCRIPTIONS" },
  ]);
  assert.deepEqual(
    rows.map((r) => r.category),
    ["RENT", "SOFTWARE_SUBSCRIPTIONS", "OTHER"]
  );
});

test("aggregateExpensesByCategory: never fabricates a zero-amount category — only categories with an actual expense appear", () => {
  const rows = aggregateExpensesByCategory([{ amount_minor: 10000, category: "RENT" }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, "RENT");
});

test("aggregateExpensesByCategory: reconciles exactly to the total of all input expenses", () => {
  const expenses = [
    { amount_minor: 300000, category: "RENT" as const },
    { amount_minor: 25000, category: "EQUIPMENT" as const },
    { amount_minor: 12345, category: "INSURANCE" as const },
  ];
  const rows = aggregateExpensesByCategory(expenses);
  const total = rows.reduce((sum, r) => sum + r.amountMinor, 0);
  const expected = expenses.reduce((sum, e) => sum + e.amount_minor, 0);
  assert.equal(total, expected);
});

test("aggregateExpensesByCategory: empty input -> empty output, no crash", () => {
  assert.deepEqual(aggregateExpensesByCategory([]), []);
});
