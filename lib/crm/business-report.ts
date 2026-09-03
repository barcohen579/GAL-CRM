// Pure calculation helpers for the Monthly Business Report
// (/dashboard, ?month=YYYY-MM). No Supabase calls here — page.tsx
// fetches, this module only derives numbers from already-fetched rows,
// same "fetch/compute split" convention as lib/crm/marketing.ts (whose
// existing safeDivide/classifyLeadAttribution/monthOverMonthChange
// this module reuses rather than re-implementing). See marketing.ts's
// buildMonthlyMetrics for the shared trend/comparison engine (Meta
// spend, revenue, business expenses, estimated profit) — this file
// covers everything the Business Report needs that ISN'T already
// there: revenue-by-service, lead-source attribution, the monthly
// sales funnel, and monthly referral-channel metrics.

import type { ServiceType, TouchpointChannel } from "./constants.ts";
import { SERVICE_TYPES } from "./constants.ts";
import { safeDivide } from "./marketing.ts";

// ------------------------------------------------------------------
// Revenue by service ("הכנסות לפי שירות")
// ------------------------------------------------------------------

export type PaymentForServiceRevenue = {
  amount: number;
  purchase: { service_type: ServiceType } | null;
};

export type ServiceRevenueRow = {
  serviceType: ServiceType | "UNCLASSIFIED";
  amountMinor: number;
};

/** Groups already-month-scoped, already-PAID payments by their
 *  Purchase's service_type — one row per public.service_type value,
 *  in SERVICE_TYPES' own declared order, PLUS an explicit
 *  "UNCLASSIFIED" bucket for the (should-never-happen, but never
 *  silently dropped either) case of a payment whose purchase lookup
 *  came back null. The sum of every row's amountMinor always equals
 *  the sum of every input payment's amount exactly — this is the
 *  reconciliation invariant the Business Report's total revenue KPI
 *  depends on holding. Zero-revenue service types are still included
 *  (amountMinor: 0) rather than omitted, so the section always shows
 *  the full, consistent vocabulary. */
export function aggregateRevenueByService(
  payments: PaymentForServiceRevenue[]
): ServiceRevenueRow[] {
  const totals = new Map<ServiceType | "UNCLASSIFIED", number>();
  for (const s of SERVICE_TYPES) totals.set(s, 0);
  totals.set("UNCLASSIFIED", 0);

  for (const p of payments) {
    const key = p.purchase?.service_type ?? "UNCLASSIFIED";
    totals.set(key, (totals.get(key) ?? 0) + p.amount);
  }

  const rows: ServiceRevenueRow[] = SERVICE_TYPES.map((s) => ({
    serviceType: s,
    amountMinor: totals.get(s) ?? 0,
  }));
  const unclassified = totals.get("UNCLASSIFIED") ?? 0;
  if (unclassified > 0) rows.push({ serviceType: "UNCLASSIFIED", amountMinor: unclassified });
  return rows;
}

// ------------------------------------------------------------------
// Lead sources ("לידים לפי מקור")
// ------------------------------------------------------------------

export type LeadForSourceAttribution = {
  id: string;
  touchpoints: { channel: TouchpointChannel; certainty: string; is_primary: boolean; created_at: string }[];
};

/** One bucket per Lead — never more, never fewer. Aggregation rule
 *  (documented per the task's explicit requirement, not left implicit):
 *    1. The touchpoint marked is_primary, if the lead has one
 *       (touchpoints.is_primary already has a DB-level "at most one
 *       per lead" guarantee — see touchpoints_one_primary_per_lead).
 *    2. Otherwise, if the lead has touchpoints but none is marked
 *       primary, the EARLIEST one by created_at — an arbitrary but
 *       deterministic, documented fallback (never "the first one
 *       returned by whatever order the query happened to use").
 *    3. Otherwise (zero touchpoints at all) — 'UNKNOWN', the same
 *       enum value this schema already uses for "no attribution
 *       recorded" everywhere else (see touchpoint_channel).
 *  A lead with 3 touchpoints therefore still contributes to exactly
 *  ONE channel's count here, never three. */
export function aggregateLeadSources(
  leads: LeadForSourceAttribution[]
): Record<TouchpointChannel, number> {
  const counts = {
    META_AD: 0,
    INSTAGRAM_ORGANIC: 0,
    INSTAGRAM_DM: 0,
    INSTAGRAM_COMMENT: 0,
    REFERRAL: 0,
    WORD_OF_MOUTH: 0,
    WALK_IN: 0,
    WEBSITE: 0,
    OTHER: 0,
    UNKNOWN: 0,
  } as Record<TouchpointChannel, number>;

  for (const lead of leads) {
    const tps = lead.touchpoints ?? [];
    let channel: TouchpointChannel;
    if (tps.length === 0) {
      channel = "UNKNOWN";
    } else {
      const primary = tps.find((t) => t.is_primary);
      if (primary) {
        channel = primary.channel;
      } else {
        const earliest = [...tps].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
        channel = earliest.channel;
      }
    }
    counts[channel] = (counts[channel] ?? 0) + 1;
  }

  return counts;
}

// ------------------------------------------------------------------
// Monthly sales funnel ("לידים חדשים" / "לקוחות חדשות" / "WON" /
// "אחוז סגירה")
// ------------------------------------------------------------------

/** Precise V1 definitions (see the task's own explicit requirement to
 *  define every metric before implementing — this is that definition,
 *  not left to the UI to guess):
 *
 *  - newLeadsCount: leads.created_at within the selected month. A
 *    cohort of leads that ARRIVED this month — regardless of what
 *    stage they're at now or when they're eventually decided.
 *  - wonCount: DISTINCT leads whose lead_stage_events has a
 *    to_stage = 'WON' row with changed_at within the selected month —
 *    i.e. leads that transitioned to WON DURING this month, regardless
 *    of when they originally arrived (same definition
 *    buildMonthlyMetrics already uses).
 *  - lostCount: the same, for to_stage = 'LOST'.
 *  - newCustomersCount: customers.customer_since within the selected
 *    month. Deliberately NOT "count of WON leads" — a directly-created
 *    Customer (no Lead at all, e.g. an existing real-world customer
 *    Gal backfills through "הוספת לקוחה") is a real new customer this
 *    month too, and would be silently missed by a WON-only count.
 *  - conversionRatePercent: wonCount / (wonCount + lostCount) — i.e.
 *    "of the leads DECIDED this month (won or lost), what fraction
 *    were won". Deliberately NOT wonCount / newLeadsCount: those are
 *    two DIFFERENT cohorts (a lead decided this month usually arrived
 *    in an earlier month, and most leads that arrive this month won't
 *    be decided until a later month) — dividing across cohorts would
 *    produce a number with no honest interpretation and could exceed
 *    100% or read as artificially low. null when nothing was decided
 *    this month (0/0), never a fabricated 0%. */
export type MonthlySalesFunnel = {
  newLeadsCount: number;
  wonCount: number;
  lostCount: number;
  newCustomersCount: number;
  conversionRatePercent: number | null;
};

export function buildMonthlySalesFunnel(input: {
  newLeadsCount: number;
  wonLeadIds: string[];
  lostLeadIds: string[];
  newCustomersCount: number;
}): MonthlySalesFunnel {
  const wonCount = new Set(input.wonLeadIds).size;
  const lostCount = new Set(input.lostLeadIds).size;
  const decided = wonCount + lostCount;
  const ratio = safeDivide(wonCount, decided);
  return {
    newLeadsCount: input.newLeadsCount,
    wonCount,
    lostCount,
    newCustomersCount: input.newCustomersCount,
    conversionRatePercent: ratio === null ? null : ratio * 100,
  };
}

// ------------------------------------------------------------------
// Monthly referral metrics ("המלצות") — direct only, never recursive,
// never framed as LTV. Mirrors the SAME shape Meta attribution already
// uses in marketing.ts: a GLOBAL set of "ever referred" customer ids
// (analogous to confirmedMetaPurchaseIds), with only the REVENUE
// figure scoped to the selected month — so a customer referred back in
// June who pays in September still correctly counts toward
// September's referral revenue, exactly like a Meta-attributed
// customer's September payment counts toward September's confirmed
// Meta revenue regardless of when the lead first arrived.
// ------------------------------------------------------------------

export type ReferralForMonthlyMetrics = {
  created_at: string;
  referred_contact_id: string;
};

export type MonthlyReferralMetrics = {
  /** Referrals CREATED during the selected month (a cohort by
   *  referral date, not by outcome date). */
  referredCount: number;
  /** Of that SAME month's referred cohort, how many currently (as of
   *  report generation) have a Customer row — a running outcome for
   *  that cohort, not restricted to "became a customer within the same
   *  calendar month". */
  becameCustomerCount: number;
  /** PAID payments in the selected month, from ANY customer who has
   *  EVER been referred (any referral month) — this is the "ongoing
   *  revenue contribution of the referral channel this month" figure,
   *  the direct analogue of confirmedMetaRevenueMinor. */
  revenueMinor: number;
};

export function buildMonthlyReferralMetrics(input: {
  /** ALL referrals ever made (not month-scoped) — used to build the
   *  "ever referred" customer-id set for the revenue figure. */
  allReferrals: ReferralForMonthlyMetrics[];
  /** contact_id -> customer_id, for every contact that has a Customer
   *  row (not just referred ones — the caller filters). */
  contactIdToCustomerId: Map<string, string>;
  /** PAID payments in the selected month, each carrying the
   *  purchase's customer_id. */
  paymentsInMonth: { amount: number; customerId: string | null }[];
  monthKey: string;
  monthKeyOf: (value: string) => string;
}): MonthlyReferralMetrics {
  const { allReferrals, contactIdToCustomerId, paymentsInMonth, monthKey, monthKeyOf } = input;

  const referredThisMonth = allReferrals.filter((r) => monthKeyOf(r.created_at) === monthKey);
  const referredCount = referredThisMonth.length;
  const becameCustomerCount = referredThisMonth.filter((r) =>
    contactIdToCustomerId.has(r.referred_contact_id)
  ).length;

  const everReferredCustomerIds = new Set(
    allReferrals
      .map((r) => contactIdToCustomerId.get(r.referred_contact_id))
      .filter((id): id is string => Boolean(id))
  );
  const revenueMinor = paymentsInMonth
    .filter((p) => p.customerId !== null && everReferredCustomerIds.has(p.customerId))
    .reduce((sum, p) => sum + p.amount, 0);

  return { referredCount, becameCustomerCount, revenueMinor };
}
