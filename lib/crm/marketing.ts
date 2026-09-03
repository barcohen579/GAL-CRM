// Pure calculation helpers for the dashboard's marketing-performance
// section. No Supabase/Meta calls here — page.tsx fetches, this module
// only derives numbers from already-fetched rows, so the math is easy
// to read and verify in isolation.
//
// ATTRIBUTION PRINCIPLE (see also touchpoints.certainty in the schema):
// a lead's paid-Meta attribution is real only when it has a touchpoint
// with channel = 'META_AD'. Certainty on that touchpoint — CONFIRMED vs
// BROAD/UNKNOWN — is never upgraded or inferred here; we only ever
// read it back. Nothing in this module invents a campaign-level link
// for a lead unless that link genuinely exists in the data.

export type MetaDailyRow = {
  meta_ad_account_id: string;
  campaign_id: string;
  campaign_name: string | null;
  metric_date: string;
  spend_minor: number;
  impressions: number;
  reach: number;
  clicks: number;
};

export type CampaignPeriodTotals = {
  meta_ad_account_id: string;
  campaign_id: string;
  campaign_name: string | null;
  spend_minor: number;
  impressions: number;
  clicks: number;
  /**
   * Sum of DAILY reach values across the period. This is NOT true
   * unique reach for the period — reach is a unique-people metric, and
   * the same person reached on two different days is counted twice
   * here. The table we store only has daily granularity (never a
   * single period-level reach from Meta), so an exact period reach
   * cannot be derived from it. Always render this labeled as an
   * approximation (e.g. "≈"), never as an exact figure.
   */
  approxReachSum: number;
  cpcMinor: number | null; // spend_minor / clicks
  cpmMinor: number | null; // spend_minor / impressions * 1000
  ctrPercent: number | null; // clicks / impressions * 100
};

/** Division that returns null instead of Infinity/NaN — callers render
 *  null as an explicit "insufficient data" state, never as 0 or "-1". */
export function safeDivide(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator === 0) return null;
  return numerator / denominator;
}

export function aggregateCampaignTotals(rows: MetaDailyRow[]): CampaignPeriodTotals[] {
  const byKey = new Map<string, CampaignPeriodTotals>();
  for (const r of rows) {
    const key = `${r.meta_ad_account_id}|${r.campaign_id}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.spend_minor += r.spend_minor;
      existing.impressions += r.impressions;
      existing.clicks += r.clicks;
      existing.approxReachSum += r.reach;
      if (r.campaign_name) existing.campaign_name = r.campaign_name;
    } else {
      byKey.set(key, {
        meta_ad_account_id: r.meta_ad_account_id,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        spend_minor: r.spend_minor,
        impressions: r.impressions,
        clicks: r.clicks,
        approxReachSum: r.reach,
        cpcMinor: null,
        cpmMinor: null,
        ctrPercent: null,
      });
    }
  }

  const totals = [...byKey.values()];
  for (const t of totals) {
    const spendNis = t.spend_minor / 100;
    const cpcNis = safeDivide(spendNis, t.clicks);
    t.cpcMinor = cpcNis === null ? null : Math.round(cpcNis * 100);
    const cpmNis = safeDivide(spendNis * 1000, t.impressions);
    t.cpmMinor = cpmNis === null ? null : Math.round(cpmNis * 100);
    const ctr = safeDivide(t.clicks, t.impressions);
    t.ctrPercent = ctr === null ? null : ctr * 100;
  }
  return totals.sort((a, b) => b.spend_minor - a.spend_minor);
}

// ------------------------------------------------------------------
// Lead attribution classification
// ------------------------------------------------------------------

export type LeadTouchpointForAttribution = {
  channel: string;
  certainty: "CONFIRMED" | "BROAD" | "UNKNOWN";
};

export type LeadAttribution = "CONFIRMED_META" | "BROAD_META" | "NOT_META";

/** A lead counts as Meta-attributed ONLY via an actual META_AD
 *  touchpoint — never inferred from timing, stage, or any other
 *  signal. "Confirmed" requires that specific touchpoint's own
 *  certainty to be CONFIRMED; any other META_AD touchpoint (BROAD or
 *  UNKNOWN certainty) makes the lead "broad/uncertain Meta", not
 *  confirmed and not excluded either. */
export function classifyLeadAttribution(
  touchpoints: LeadTouchpointForAttribution[]
): LeadAttribution {
  const metaTouchpoints = touchpoints.filter((t) => t.channel === "META_AD");
  if (metaTouchpoints.length === 0) return "NOT_META";
  const hasConfirmed = metaTouchpoints.some((t) => t.certainty === "CONFIRMED");
  return hasConfirmed ? "CONFIRMED_META" : "BROAD_META";
}

// ------------------------------------------------------------------
// Monthly business-performance section
// ------------------------------------------------------------------

export type MonthOverMonthChange = {
  /** Signed percent, e.g. 12.5 or -8.3. */
  percent: number;
  direction: "up" | "down" | "flat";
} | null; // null = no valid comparison (no previous-month data, or previous was 0)

/** Safe month-over-month percent change. Returns null — never
 *  Infinity/NaN — when there's nothing valid to compare against
 *  (no previous-month figure at all, or a previous value of 0, which
 *  makes "percent change" mathematically undefined rather than some
 *  huge/infinite number). */
export function monthOverMonthChange(
  current: number,
  previous: number | null | undefined
): MonthOverMonthChange {
  if (previous === null || previous === undefined) return null;
  if (previous === 0) return null;
  const percent = ((current - previous) / previous) * 100;
  if (!Number.isFinite(percent)) return null;
  const direction = percent > 0 ? "up" : percent < 0 ? "down" : "flat";
  return { percent, direction };
}

export type MonthlyMetrics = {
  monthKey: string;
  label: string;
  isCurrentMonth: boolean;
  /** null = Meta sync never covered this month at all (unknown, NOT ₪0). */
  metaSpendMinor: number | null;
  newLeadsCount: number;
  metaAttributedLeadsCount: number;
  confirmedMetaLeadsCount: number;
  broadMetaLeadsCount: number;
  wonCount: number;
  revenueMinor: number;
  primaryCplMinor: number | null;
  revenueToSpendRatio: number | null;
  confirmedMetaRevenueMinor: number;
  confirmedMetaRoas: number | null;
  /** Manually-entered business_expenses only — never Meta spend (that
   *  stays in metaSpendMinor, its own separate figure). Always a real
   *  number (0 when none were entered) — unlike metaSpendMinor, there
   *  is no "unsynced" concept for manual data: no rows genuinely means
   *  ₪0 was entered. */
  otherExpensesMinor: number;
  /** metaSpendMinor + otherExpensesMinor. null whenever metaSpendMinor
   *  is null — an unknown Meta figure must never be silently treated
   *  as 0 (that would understate total expenses and overstate profit). */
  totalExpensesMinor: number | null;
  /** רווח משוער — revenueMinor - totalExpensesMinor. A MANAGEMENT
   *  metric only: no VAT/income tax/National Insurance/depreciation is
   *  represented anywhere in this schema, so this is never accounting
   *  net profit. null whenever totalExpensesMinor is null, for the
   *  same reason. */
  estimatedProfitMinor: number | null;
  changeVsPreviousMonth: {
    metaSpend: MonthOverMonthChange;
    newLeads: MonthOverMonthChange;
    won: MonthOverMonthChange;
    revenue: MonthOverMonthChange;
    otherExpenses: MonthOverMonthChange;
    totalExpenses: MonthOverMonthChange;
    estimatedProfit: MonthOverMonthChange;
  };
};

/** Builds one MonthlyMetrics row per calendar month for which any
 *  relevant data exists (leads, Meta spend, or revenue) — never
 *  starting artificially at the current month. Meta spend is null
 *  (not 0) for a month the sync never touched at all, determined by
 *  whether that month falls within the overall min/max metric_date
 *  actually present in meta_campaign_daily_metrics; a month inside
 *  that synced span with zero rows genuinely had zero spend, so it's
 *  reported as 0, not "unknown". */
export function buildMonthlyMetrics(input: {
  metaRows: MetaDailyRow[];
  leads: { id: string; created_at: string; touchpoints: LeadTouchpointForAttribution[] }[];
  wonEvents: { lead_id: string; changed_at: string }[];
  payments: { amount: number; paid_at: string; purchase_id: string }[];
  confirmedMetaPurchaseIds: string[];
  /** Manually-entered business_expenses rows — never Meta spend. */
  businessExpenses?: { amount_minor: number; expense_date: string }[];
  currentMonthKey: string;
  monthKeyOf: (value: string) => string;
  previousMonthKeyOf: (key: string) => string;
  formatMonthLabel: (key: string) => string;
}): MonthlyMetrics[] {
  const {
    metaRows,
    leads,
    wonEvents,
    payments,
    confirmedMetaPurchaseIds,
    businessExpenses = [],
    currentMonthKey: curKey,
    monthKeyOf,
    previousMonthKeyOf,
    formatMonthLabel,
  } = input;

  const confirmedPurchaseIdSet = new Set(confirmedMetaPurchaseIds);

  // Determine the synced Meta span, to distinguish "0 spend this
  // month" from "never synced this month".
  const metaMonthKeys = metaRows.map((r) => monthKeyOf(r.metric_date));
  const syncedMonthMin = metaMonthKeys.length > 0 ? metaMonthKeys.reduce((a, b) => (a < b ? a : b)) : null;
  const syncedMonthMax = metaMonthKeys.length > 0 ? metaMonthKeys.reduce((a, b) => (a > b ? a : b)) : null;
  const isMonthWithinSyncedSpan = (key: string) =>
    syncedMonthMin !== null && syncedMonthMax !== null && key >= syncedMonthMin && key <= syncedMonthMax;

  // Union of every month with any relevant data at all.
  const monthKeys = new Set<string>();
  for (const r of metaRows) monthKeys.add(monthKeyOf(r.metric_date));
  for (const l of leads) monthKeys.add(monthKeyOf(l.created_at));
  for (const p of payments) monthKeys.add(monthKeyOf(p.paid_at));
  for (const e of businessExpenses) monthKeys.add(monthKeyOf(e.expense_date));
  // wonEvents intentionally not added on its own — a WON transition
  // implies the lead exists, so its month is already covered via
  // `leads`; this avoids a WON-only month with no other context.

  const sortedKeys = [...monthKeys].sort(); // ascending, for MoM lookups

  const perMonth = new Map<
    string,
    {
      metaSpendMinor: number;
      newLeadsCount: number;
      metaAttributedLeadsCount: number;
      confirmedMetaLeadsCount: number;
      broadMetaLeadsCount: number;
      wonCount: number;
      revenueMinor: number;
      confirmedMetaRevenueMinor: number;
      otherExpensesMinor: number;
    }
  >();
  const emptyBucket = () => ({
    metaSpendMinor: 0,
    newLeadsCount: 0,
    metaAttributedLeadsCount: 0,
    confirmedMetaLeadsCount: 0,
    broadMetaLeadsCount: 0,
    wonCount: 0,
    revenueMinor: 0,
    confirmedMetaRevenueMinor: 0,
    otherExpensesMinor: 0,
  });
  for (const key of sortedKeys) perMonth.set(key, emptyBucket());

  for (const r of metaRows) {
    const key = monthKeyOf(r.metric_date);
    const bucket = perMonth.get(key);
    if (bucket) bucket.metaSpendMinor += r.spend_minor;
  }

  for (const e of businessExpenses) {
    const key = monthKeyOf(e.expense_date);
    const bucket = perMonth.get(key);
    if (bucket) bucket.otherExpensesMinor += e.amount_minor;
  }

  for (const l of leads) {
    const key = monthKeyOf(l.created_at);
    const bucket = perMonth.get(key);
    if (!bucket) continue;
    bucket.newLeadsCount += 1;
    const classification = classifyLeadAttribution(l.touchpoints ?? []);
    if (classification === "CONFIRMED_META") bucket.confirmedMetaLeadsCount += 1;
    else if (classification === "BROAD_META") bucket.broadMetaLeadsCount += 1;
  }
  for (const bucket of perMonth.values()) {
    bucket.metaAttributedLeadsCount = bucket.confirmedMetaLeadsCount + bucket.broadMetaLeadsCount;
  }

  const wonLeadByMonth = new Map<string, Set<string>>();
  for (const e of wonEvents) {
    const key = monthKeyOf(e.changed_at);
    if (!perMonth.has(key)) continue; // WON in a month with no other tracked data — ignore rather than fabricate a row
    if (!wonLeadByMonth.has(key)) wonLeadByMonth.set(key, new Set());
    wonLeadByMonth.get(key)!.add(e.lead_id);
  }
  for (const [key, leadIds] of wonLeadByMonth) {
    perMonth.get(key)!.wonCount = leadIds.size;
  }

  for (const p of payments) {
    const key = monthKeyOf(p.paid_at);
    const bucket = perMonth.get(key);
    if (!bucket) continue;
    bucket.revenueMinor += p.amount;
    if (confirmedPurchaseIdSet.has(p.purchase_id)) bucket.confirmedMetaRevenueMinor += p.amount;
  }

  // Whether ANY confirmed-Meta lead exists at all (globally) determines
  // whether ROAS is shown as a real "0×" vs "not yet reliably
  // measurable" for a month with no confirmed revenue of its own.
  const confirmedMetaLeadsExistAnywhere = confirmedMetaPurchaseIds.length > 0;

  const results: MonthlyMetrics[] = sortedKeys
    .map((key) => {
      const bucket = perMonth.get(key)!;
      const metaSpendMinor = isMonthWithinSyncedSpan(key) ? bucket.metaSpendMinor : null;
      const metaSpendNis = (metaSpendMinor ?? 0) / 100;

      const primaryCplNis = safeDivide(metaSpendNis, bucket.confirmedMetaLeadsCount);
      const primaryCplMinor =
        metaSpendMinor === null || primaryCplNis === null ? null : Math.round(primaryCplNis * 100);

      const revenueToSpendRatio =
        metaSpendMinor === null ? null : safeDivide(bucket.revenueMinor, metaSpendMinor);

      const confirmedMetaRoas =
        metaSpendMinor === null || !confirmedMetaLeadsExistAnywhere
          ? null
          : safeDivide(bucket.confirmedMetaRevenueMinor, metaSpendMinor);

      // Total expenses / estimated profit — null whenever metaSpendMinor
      // is null (an unsynced month), never silently treated as "Meta
      // spent ₪0" — see MonthlyMetrics's own field comments.
      const totalExpensesMinor = metaSpendMinor === null ? null : metaSpendMinor + bucket.otherExpensesMinor;
      const estimatedProfitMinor =
        totalExpensesMinor === null ? null : bucket.revenueMinor - totalExpensesMinor;

      const prevKey = previousMonthKeyOf(key);
      const prevBucket = perMonth.get(prevKey) ?? null;
      const prevMetaSpend =
        prevBucket === null ? null : isMonthWithinSyncedSpan(prevKey) ? prevBucket.metaSpendMinor : null;
      const prevTotalExpenses =
        prevMetaSpend === null || prevBucket === null ? null : prevMetaSpend + prevBucket.otherExpensesMinor;
      const prevEstimatedProfit =
        prevTotalExpenses === null || prevBucket === null ? null : prevBucket.revenueMinor - prevTotalExpenses;

      const isCurrentMonth = key === curKey;

      // The current month is still in progress — comparing its partial
      // total against a previous FULL month (e.g. 3 days of September
      // vs all of August) is mathematically valid but business-
      // misleading (a real drop reads as a huge, alarming swing). Show
      // no MoM badge at all for the current month; completed months
      // keep comparing normally against the previous completed month.
      // Same-days-so-far comparison is a deliberate future enhancement,
      // not implemented here.
      const changeVsPreviousMonth = isCurrentMonth
        ? {
            metaSpend: null,
            newLeads: null,
            won: null,
            revenue: null,
            otherExpenses: null,
            totalExpenses: null,
            estimatedProfit: null,
          }
        : {
            // No comparison at all when THIS month's own spend is
            // unknown — showing a % against an implied "0" would claim
            // more precision than we have.
            metaSpend: metaSpendMinor === null ? null : monthOverMonthChange(metaSpendMinor, prevMetaSpend),
            newLeads: monthOverMonthChange(bucket.newLeadsCount, prevBucket?.newLeadsCount),
            won: monthOverMonthChange(bucket.wonCount, prevBucket?.wonCount),
            revenue: monthOverMonthChange(bucket.revenueMinor, prevBucket?.revenueMinor),
            otherExpenses: monthOverMonthChange(bucket.otherExpensesMinor, prevBucket?.otherExpensesMinor),
            totalExpenses:
              totalExpensesMinor === null ? null : monthOverMonthChange(totalExpensesMinor, prevTotalExpenses),
            estimatedProfit:
              estimatedProfitMinor === null
                ? null
                : monthOverMonthChange(estimatedProfitMinor, prevEstimatedProfit),
          };

      return {
        monthKey: key,
        label: formatMonthLabel(key),
        isCurrentMonth,
        metaSpendMinor,
        newLeadsCount: bucket.newLeadsCount,
        metaAttributedLeadsCount: bucket.metaAttributedLeadsCount,
        confirmedMetaLeadsCount: bucket.confirmedMetaLeadsCount,
        broadMetaLeadsCount: bucket.broadMetaLeadsCount,
        wonCount: bucket.wonCount,
        revenueMinor: bucket.revenueMinor,
        primaryCplMinor,
        revenueToSpendRatio,
        confirmedMetaRevenueMinor: bucket.confirmedMetaRevenueMinor,
        confirmedMetaRoas,
        otherExpensesMinor: bucket.otherExpensesMinor,
        totalExpensesMinor,
        estimatedProfitMinor,
        changeVsPreviousMonth,
      };
    })
    .sort((a, b) => b.monthKey.localeCompare(a.monthKey)); // newest first for display

  return results;
}
