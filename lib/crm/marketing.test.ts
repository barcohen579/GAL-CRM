import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLeadAttribution, buildMonthlyMetrics } from "./marketing.ts";
import { monthKeyOf, previousMonthKeyOf, formatMonthLabel } from "./date-range.ts";

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

// ------------------------------------------------------------------
// buildMonthlyMetrics — Monthly Business Report's shared trend/
// comparison engine (also used by /dashboard's existing "ביצועים
// חודשיים" table). `payments` here is always expected PRE-FILTERED to
// status = PAID by the caller (see app/(app)/dashboard/page.tsx's own
// query) — buildMonthlyMetrics itself never re-checks status, exactly
// like it never re-checks anything about `leads`/`metaRows` either;
// this mirrors the module's existing "page.tsx fetches, this module
// only derives numbers" boundary (see the file's own header comment).
// ------------------------------------------------------------------

const baseArgs = {
  currentMonthKey: monthKeyOf(new Date()),
  monthKeyOf,
  previousMonthKeyOf,
  formatMonthLabel,
};

function monthsAgoKey(n: number): string {
  let key = monthKeyOf(new Date());
  for (let i = 0; i < n; i++) key = previousMonthKeyOf(key);
  return key;
}

test("buildMonthlyMetrics: revenue is summed by paid_at's month, not any creation date", () => {
  const sep = monthsAgoKey(1);
  const [y, m] = sep.split("-");
  const septemberDate = `${y}-${m}-25`;
  const result = buildMonthlyMetrics({
    ...baseArgs,
    metaRows: [],
    leads: [],
    wonEvents: [],
    payments: [
      { amount: 35000, paid_at: septemberDate, purchase_id: "p1" },
      { amount: 12000, paid_at: septemberDate, purchase_id: "p2" },
    ],
    confirmedMetaPurchaseIds: [],
  });
  const row = result.find((r) => r.monthKey === sep)!;
  assert.equal(row.revenueMinor, 47000);
});

test("buildMonthlyMetrics: totalExpenses = Meta spend + business expenses, never one without the other", () => {
  const key = monthsAgoKey(1);
  const [y, m] = key.split("-");
  const dateInMonth = `${y}-${m}-10`;
  const result = buildMonthlyMetrics({
    ...baseArgs,
    metaRows: [
      { meta_ad_account_id: "act_1", campaign_id: "c1", campaign_name: "C1", metric_date: dateInMonth, spend_minor: 200000, impressions: 100, reach: 50, clicks: 10 },
    ],
    leads: [],
    wonEvents: [],
    payments: [],
    confirmedMetaPurchaseIds: [],
    businessExpenses: [{ amount_minor: 80000, expense_date: dateInMonth }],
  });
  const row = result.find((r) => r.monthKey === key)!;
  assert.equal(row.metaSpendMinor, 200000);
  assert.equal(row.otherExpensesMinor, 80000);
  assert.equal(row.totalExpensesMinor, 280000, "Meta spend + business expenses");
});

test("buildMonthlyMetrics: estimatedProfit = revenue - totalExpenses", () => {
  const key = monthsAgoKey(1);
  const [y, m] = key.split("-");
  const dateInMonth = `${y}-${m}-10`;
  const result = buildMonthlyMetrics({
    ...baseArgs,
    metaRows: [
      { meta_ad_account_id: "act_1", campaign_id: "c1", campaign_name: "C1", metric_date: dateInMonth, spend_minor: 100000, impressions: 100, reach: 50, clicks: 10 },
    ],
    leads: [],
    wonEvents: [],
    payments: [{ amount: 500000, paid_at: dateInMonth, purchase_id: "p1" }],
    confirmedMetaPurchaseIds: [],
    businessExpenses: [{ amount_minor: 50000, expense_date: dateInMonth }],
  });
  const row = result.find((r) => r.monthKey === key)!;
  // revenue 500000, totalExpenses = 100000 + 50000 = 150000
  assert.equal(row.estimatedProfitMinor, 350000);
});

test("buildMonthlyMetrics: a business expense is attributed to its OWN expense_date month, never the current/report-generation month", () => {
  const twoMonthsAgo = monthsAgoKey(2);
  const [y, m] = twoMonthsAgo.split("-");
  const oldDate = `${y}-${m}-05`;
  const result = buildMonthlyMetrics({
    ...baseArgs,
    metaRows: [],
    leads: [],
    wonEvents: [],
    payments: [],
    confirmedMetaPurchaseIds: [],
    businessExpenses: [{ amount_minor: 80000, expense_date: oldDate }],
  });
  const oldRow = result.find((r) => r.monthKey === twoMonthsAgo)!;
  assert.equal(oldRow.otherExpensesMinor, 80000);
  const currentRow = result.find((r) => r.monthKey === baseArgs.currentMonthKey);
  assert.equal(currentRow?.otherExpensesMinor ?? 0, 0, "must not leak into the current month");
});

test("buildMonthlyMetrics: Meta spend is never counted as a business expense, and business expenses never inflate Meta spend", () => {
  const key = monthsAgoKey(1);
  const [y, m] = key.split("-");
  const dateInMonth = `${y}-${m}-10`;
  const result = buildMonthlyMetrics({
    ...baseArgs,
    metaRows: [
      { meta_ad_account_id: "act_1", campaign_id: "c1", campaign_name: null, metric_date: dateInMonth, spend_minor: 100000, impressions: 0, reach: 0, clicks: 0 },
    ],
    leads: [],
    wonEvents: [],
    payments: [],
    confirmedMetaPurchaseIds: [],
    businessExpenses: [{ amount_minor: 30000, expense_date: dateInMonth }],
  });
  const row = result.find((r) => r.monthKey === key)!;
  assert.equal(row.metaSpendMinor, 100000, "Meta spend must stay exactly what meta_campaign_daily_metrics reported");
  assert.equal(row.otherExpensesMinor, 30000, "business expenses must stay exactly what was entered, no Meta mixed in");
});

test("buildMonthlyMetrics: totalExpenses/estimatedProfit are null (unknown), never a misleading 0/full-revenue, when Meta was never synced that month", () => {
  const key = monthsAgoKey(1);
  const [y, m] = key.split("-");
  const dateInMonth = `${y}-${m}-10`;
  const result = buildMonthlyMetrics({
    ...baseArgs,
    metaRows: [], // never synced at all
    leads: [],
    wonEvents: [],
    payments: [{ amount: 100000, paid_at: dateInMonth, purchase_id: "p1" }],
    confirmedMetaPurchaseIds: [],
    businessExpenses: [{ amount_minor: 20000, expense_date: dateInMonth }],
  });
  const row = result.find((r) => r.monthKey === key)!;
  assert.equal(row.metaSpendMinor, null);
  assert.equal(row.totalExpensesMinor, null);
  assert.equal(row.estimatedProfitMinor, null);
});

test("buildMonthlyMetrics: a month with ONLY a business expense (no leads/payments/Meta) still produces a row", () => {
  const key = monthsAgoKey(3);
  const [y, m] = key.split("-");
  const dateInMonth = `${y}-${m}-15`;
  const result = buildMonthlyMetrics({
    ...baseArgs,
    metaRows: [],
    leads: [],
    wonEvents: [],
    payments: [],
    confirmedMetaPurchaseIds: [],
    businessExpenses: [{ amount_minor: 15000, expense_date: dateInMonth }],
  });
  const row = result.find((r) => r.monthKey === key);
  assert.ok(row, "a month with only an expense must still appear");
  assert.equal(row!.otherExpensesMinor, 15000);
});
