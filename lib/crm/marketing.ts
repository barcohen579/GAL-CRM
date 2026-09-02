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
