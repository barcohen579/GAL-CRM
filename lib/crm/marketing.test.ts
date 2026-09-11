import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyLeadAttribution,
  buildMonthlyMetrics,
  computeCurrentPeriodBusinessSnapshot,
  aggregateCampaignTotals,
} from "./marketing.ts";
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

// Critical financial rule (explicitly re-confirmed, not just inherited):
// total Meta advertising expense must include ALL legitimate paid spend
// from the configured accounts -- lead campaigns, engagement campaigns,
// boosted posts, anything Meta reports spend for -- never limited to
// campaigns that happen to have a lead/touchpoint attached. Lead
// attribution (classifyLeadAttribution / confirmedMetaRevenueMinor) is
// a completely separate concern from this sum.
test("buildMonthlyMetrics: an engagement/boosted-post campaign with ZERO lead attribution still fully counts toward metaSpendMinor", () => {
  const key = monthsAgoKey(1);
  const [y, m] = key.split("-");
  const dateInMonth = `${y}-${m}-10`;
  const result = buildMonthlyMetrics({
    ...baseArgs,
    metaRows: [
      {
        meta_ad_account_id: "act_2070492616442158",
        campaign_id: "120247020269420068",
        campaign_name: "קמפיין מעורבות חדש",
        objective: "OUTCOME_ENGAGEMENT",
        effective_status: "ACTIVE",
        metric_date: dateInMonth,
        spend_minor: 1448,
        impressions: 586,
        reach: 542,
        clicks: 40,
      },
    ],
    // No leads/touchpoints/confirmed-Meta purchases reference this
    // campaign at all -- an engagement/boosted-post campaign typically
    // never generates a Lead the way a OUTCOME_LEADS campaign does.
    leads: [],
    wonEvents: [],
    payments: [],
    confirmedMetaPurchaseIds: [],
    businessExpenses: [],
  });
  const row = result.find((r) => r.monthKey === key)!;
  assert.equal(row.metaSpendMinor, 1448, "an engagement campaign's spend must count toward the financial total even with zero lead attribution");
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

// ------------------------------------------------------------------
// computeCurrentPeriodBusinessSnapshot — "מגמת העסק"'s current-partial-
// period vs same-date-range-last-month comparison. Uses real relative
// month keys (baseArgs.currentMonthKey / previousMonthKeyOf), same
// "never a hardcoded absolute date" convention as monthsAgoKey above —
// day 15 is deliberately chosen as "today" so every scenario is valid
// regardless of which real month the test suite happens to run in
// (every calendar month has at least 28 days).
// ------------------------------------------------------------------

test("computeCurrentPeriodBusinessSnapshot: only counts up-to-today rows in the current month, and up-to-the-same-day rows in the previous month — a later date in either month is excluded", () => {
  const currentKey = baseArgs.currentMonthKey;
  const prevKey = previousMonthKeyOf(currentKey);
  const todayDateKey = `${currentKey}-15`;

  const result = computeCurrentPeriodBusinessSnapshot({
    payments: [
      { amount: 10000, paid_at: `${currentKey}-05` },
      { amount: 5000, paid_at: `${currentKey}-15` }, // exactly today -- included
      { amount: 99999, paid_at: `${currentKey}-16` }, // AFTER today -- must be excluded
      { amount: 8000, paid_at: `${prevKey}-05` },
      { amount: 4000, paid_at: `${prevKey}-15` }, // exactly the capped day -- included
      { amount: 77777, paid_at: `${prevKey}-16` }, // AFTER the capped day -- excluded
    ],
    businessExpenses: [],
    metaRows: [],
    todayDateKey,
    monthKeyOf,
    previousMonthKeyOf,
  });

  assert.equal(result.currentRangeStart, `${currentKey}-01`);
  assert.equal(result.currentRangeEnd, todayDateKey);
  assert.equal(result.previousRangeStart, `${prevKey}-01`);
  assert.equal(result.previousRangeEnd, `${prevKey}-15`);
  assert.equal(result.revenue.currentMinor, 15000);
  assert.equal(result.revenue.previousMinor, 12000);
});

test("computeCurrentPeriodBusinessSnapshot: positive revenue growth", () => {
  const currentKey = baseArgs.currentMonthKey;
  const prevKey = previousMonthKeyOf(currentKey);
  const result = computeCurrentPeriodBusinessSnapshot({
    payments: [
      { amount: 20000, paid_at: `${currentKey}-10` },
      { amount: 10000, paid_at: `${prevKey}-10` },
    ],
    businessExpenses: [],
    metaRows: [],
    todayDateKey: `${currentKey}-10`,
    monthKeyOf,
    previousMonthKeyOf,
  });
  assert.equal(result.revenue.change?.direction, "up");
  assert.equal(result.revenue.change?.percent, 100);
});

test("computeCurrentPeriodBusinessSnapshot: negative revenue growth", () => {
  const currentKey = baseArgs.currentMonthKey;
  const prevKey = previousMonthKeyOf(currentKey);
  const result = computeCurrentPeriodBusinessSnapshot({
    payments: [
      { amount: 5000, paid_at: `${currentKey}-10` },
      { amount: 20000, paid_at: `${prevKey}-10` },
    ],
    businessExpenses: [],
    metaRows: [],
    todayDateKey: `${currentKey}-10`,
    monthKeyOf,
    previousMonthKeyOf,
  });
  assert.equal(result.revenue.change?.direction, "down");
  assert.equal(result.revenue.change?.percent, -75);
});

test("computeCurrentPeriodBusinessSnapshot: no change (flat)", () => {
  const currentKey = baseArgs.currentMonthKey;
  const prevKey = previousMonthKeyOf(currentKey);
  const result = computeCurrentPeriodBusinessSnapshot({
    payments: [
      { amount: 10000, paid_at: `${currentKey}-10` },
      { amount: 10000, paid_at: `${prevKey}-10` },
    ],
    businessExpenses: [],
    metaRows: [],
    todayDateKey: `${currentKey}-10`,
    monthKeyOf,
    previousMonthKeyOf,
  });
  assert.equal(result.revenue.change?.direction, "flat");
  assert.equal(result.revenue.change?.percent, 0);
});

test("computeCurrentPeriodBusinessSnapshot: zero previous-period revenue -> change is null, never NaN/Infinity", () => {
  const currentKey = baseArgs.currentMonthKey;
  const result = computeCurrentPeriodBusinessSnapshot({
    payments: [{ amount: 10000, paid_at: `${currentKey}-10` }],
    businessExpenses: [],
    metaRows: [],
    todayDateKey: `${currentKey}-10`,
    monthKeyOf,
    previousMonthKeyOf,
  });
  assert.equal(result.revenue.previousMinor, 0);
  assert.equal(result.revenue.change, null);
  assert.ok(Number.isFinite(result.revenue.currentMinor));
});

test("computeCurrentPeriodBusinessSnapshot: a GENERAL payment (no purchase_id in the shape at all) is included in revenue exactly like any other PAID payment", () => {
  const currentKey = baseArgs.currentMonthKey;
  // No purchase_id field anywhere -- this function's own payments param
  // type never requires one, so a GENERAL-payment-shaped row is
  // indistinguishable from a CUSTOMER one here by construction.
  const result = computeCurrentPeriodBusinessSnapshot({
    payments: [{ amount: 30000, paid_at: `${currentKey}-10` }],
    businessExpenses: [],
    metaRows: [],
    todayDateKey: `${currentKey}-10`,
    monthKeyOf,
    previousMonthKeyOf,
  });
  assert.equal(result.revenue.currentMinor, 30000);
});

test("computeCurrentPeriodBusinessSnapshot: expenses = Meta spend + business expenses, and profit = revenue - expenses, for both periods", () => {
  const currentKey = baseArgs.currentMonthKey;
  const prevKey = previousMonthKeyOf(currentKey);
  const result = computeCurrentPeriodBusinessSnapshot({
    payments: [
      { amount: 50000, paid_at: `${currentKey}-10` },
      { amount: 40000, paid_at: `${prevKey}-10` },
    ],
    businessExpenses: [
      { amount_minor: 5000, expense_date: `${currentKey}-10` },
      { amount_minor: 3000, expense_date: `${prevKey}-10` },
    ],
    metaRows: [
      { spend_minor: 2000, metric_date: `${currentKey}-10` },
      { spend_minor: 1000, metric_date: `${prevKey}-10` },
    ],
    todayDateKey: `${currentKey}-10`,
    monthKeyOf,
    previousMonthKeyOf,
  });
  assert.equal(result.expenses.currentMinor, 7000, "current expenses = business (5000) + Meta (2000)");
  assert.equal(result.expenses.previousMinor, 4000, "previous expenses = business (3000) + Meta (1000)");
  assert.equal(result.profit.currentMinor, 43000, "current profit = revenue (50000) - expenses (7000)");
  assert.equal(result.profit.previousMinor, 36000, "previous profit = revenue (40000) - expenses (4000)");
});

// ------------------------------------------------------------------
// aggregateCampaignTotals — earliestDate/latestDate (new: lets the UI
// look up an account-wide, non-attributed Instagram follower change
// "during the promotion's own window", not a fixed month-wide range).
// Existing CPC/CPM/CTR/spend aggregation behavior is untouched by this
// addition -- no existing test needed updating.
// ------------------------------------------------------------------

test("aggregateCampaignTotals: earliestDate/latestDate track a campaign's own real active window across its rows, regardless of row order", () => {
  const totals = aggregateCampaignTotals([
    {
      meta_ad_account_id: "act_1",
      campaign_id: "c1",
      campaign_name: "Campaign 1",
      metric_date: "2026-09-05",
      spend_minor: 500,
      impressions: 10,
      reach: 8,
      clicks: 1,
    },
    {
      meta_ad_account_id: "act_1",
      campaign_id: "c1",
      campaign_name: "Campaign 1",
      metric_date: "2026-09-03",
      spend_minor: 500,
      impressions: 10,
      reach: 8,
      clicks: 1,
    },
    {
      meta_ad_account_id: "act_1",
      campaign_id: "c1",
      campaign_name: "Campaign 1",
      metric_date: "2026-09-07",
      spend_minor: 500,
      impressions: 10,
      reach: 8,
      clicks: 1,
    },
  ]);
  assert.equal(totals.length, 1);
  assert.equal(totals[0].earliestDate, "2026-09-03");
  assert.equal(totals[0].latestDate, "2026-09-07");
});

test("aggregateCampaignTotals: a single-day campaign has earliestDate === latestDate", () => {
  const totals = aggregateCampaignTotals([
    {
      meta_ad_account_id: "act_1",
      campaign_id: "c1",
      campaign_name: "Campaign 1",
      metric_date: "2026-09-11",
      spend_minor: 1448,
      impressions: 586,
      reach: 542,
      clicks: 40,
    },
  ]);
  assert.equal(totals[0].earliestDate, "2026-09-11");
  assert.equal(totals[0].latestDate, "2026-09-11");
});
