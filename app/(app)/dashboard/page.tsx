import type { Metadata } from "next";
import Link from "next/link";
import {
  UserPlus,
  Clock,
  Dumbbell,
  Wallet,
  ArrowLeft,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import {
  MarketingPerformance,
  type MarketingPerformanceData,
} from "@/components/dashboard/marketing-performance";
import { MonthlyPerformance } from "@/components/dashboard/monthly-performance";
import { BusinessReport, type BusinessReportData } from "@/components/dashboard/business-report";
import {
  LEAD_STAGE_LABELS,
  LEAD_STAGE_TONE,
  SERVICE_TYPE_LABELS,
} from "@/lib/crm/constants";
import { formatDate, formatMoney, formatRelative } from "@/lib/crm/format";
import {
  resolveMarketingRange,
  resolveSelectedMonth,
  currentMonthKey,
  monthKeyOf,
  previousMonthKeyOf,
  formatMonthLabel,
} from "@/lib/crm/date-range";
import {
  aggregateCampaignTotals,
  classifyLeadAttribution,
  safeDivide,
  buildMonthlyMetrics,
  type MetaDailyRow,
  type LeadTouchpointForAttribution,
  type MonthlyMetrics,
} from "@/lib/crm/marketing";
import {
  aggregateRevenueByService,
  aggregateLeadSources,
  buildMonthlySalesFunnel,
  buildMonthlyReferralMetrics,
} from "@/lib/crm/business-report";
import type { LeadStage, ServiceType, TouchpointChannel } from "@/lib/crm/constants";

export const metadata: Metadata = { title: "לוח בקרה — GAL CRM" };
export const dynamic = "force-dynamic";

type RecentLead = {
  id: string;
  stage: LeadStage;
  interested_services: { service_type: ServiceType }[];
  created_at: string;
  contact: { full_name: string } | null;
};

type UpcomingFollowUp = {
  id: string;
  title: string;
  due_at: string;
  lead: { id: string; contact: { full_name: string } | null } | null;
  customer: { id: string; contact: { full_name: string } | null } | null;
};

type RecentPayment = {
  id: string;
  amount: number;
  currency: string;
  paid_at: string;
  purchase: {
    service_type: ServiceType;
    custom_service_name: string | null;
    customer: { id: string; contact: { full_name: string } | null } | null;
  } | null;
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; month?: string }>;
}) {
  const { range: rangeParam, month: monthParam } = await searchParams;
  const range = resolveMarketingRange(rangeParam);
  const selectedMonth = resolveSelectedMonth(monthParam);

  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  const [
    newLeadsRes,
    followUpsDueRes,
    trialsBookedRes,
    recentLeadsRes,
    upcomingFollowUpsRes,
    recentPaymentsRes,
    metaMetricsRes,
    leadsInRangeWithTouchpointsRes,
    wonEventsInRangeRes,
    revenuePaymentsInRangeRes,
    confirmedMetaTouchpointsRes,
    allMetaRowsRes,
    allLeadsWithTouchpointsRes,
    allWonEventsRes,
    allPaidPaymentsRes,
    allBusinessExpensesRes,
    businessExpensesInMonthRes,
    paymentsInMonthWithServiceRes,
    leadsInMonthWithFullTouchpointsRes,
    lostEventsInMonthRes,
    newCustomersInMonthRes,
    allReferralsRes,
    allCustomersContactMapRes,
  ] = await Promise.all([
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("stage", "NEW"),
    supabase
      .from("follow_up_tasks")
      .select("id", { count: "exact", head: true })
      .eq("status", "PENDING")
      .lte("due_at", nowIso),
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("stage", "TRIAL_BOOKED"),
    supabase
      .from("leads")
      .select(
        "id, stage, created_at, interested_services:lead_interested_services(service_type), contact:contacts(full_name)"
      )
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("follow_up_tasks")
      .select(
        "id, title, due_at, lead:leads(id, contact:contacts(full_name)), customer:customers(id, contact:contacts(full_name))"
      )
      .eq("status", "PENDING")
      .order("due_at", { ascending: true })
      .limit(5),
    supabase
      .from("payments")
      .select(
        "id, amount, currency, paid_at, purchase:purchases(service_type, custom_service_name, customer:customers(id, contact:contacts(full_name)))"
      )
      .eq("status", "PAID")
      .order("paid_at", { ascending: false })
      .limit(5),

    // ---- Marketing section (Phase 2), all scoped to the selected range ----
    supabase
      .from("meta_campaign_daily_metrics")
      .select("meta_ad_account_id, campaign_id, campaign_name, metric_date, spend_minor, impressions, reach, clicks")
      .gte("metric_date", range.sinceDate)
      .lte("metric_date", range.untilDate),
    supabase
      .from("leads")
      .select("id, touchpoints(channel, certainty)")
      .gte("created_at", range.sinceTimestamp)
      .lt("created_at", range.untilTimestampExclusive),
    supabase
      .from("lead_stage_events")
      .select("id, lead_id")
      .eq("to_stage", "WON")
      .gte("changed_at", range.sinceTimestamp)
      .lt("changed_at", range.untilTimestampExclusive),
    supabase
      .from("payments")
      .select("amount, purchase_id")
      .eq("status", "PAID")
      .gte("paid_at", range.sinceDate)
      .lte("paid_at", range.untilDate),
    // Global (not range-scoped): whether ANY confirmed-Meta lead exists
    // at all — a lead's confirmed attribution is a fixed property, not
    // itself date-ranged; only the resulting revenue is range-filtered.
    supabase
      .from("touchpoints")
      .select("lead_id")
      .eq("channel", "META_AD")
      .eq("certainty", "CONFIRMED"),

    // ---- Monthly performance section — deliberately ALL-TIME (not
    // range-scoped), so history isn't artificially cut at the current
    // range selection. ----
    supabase
      .from("meta_campaign_daily_metrics")
      .select("meta_ad_account_id, campaign_id, campaign_name, metric_date, spend_minor, impressions, reach, clicks"),
    supabase.from("leads").select("id, created_at, touchpoints(channel, certainty)"),
    supabase.from("lead_stage_events").select("lead_id, changed_at").eq("to_stage", "WON"),
    supabase.from("payments").select("amount, paid_at, purchase_id").eq("status", "PAID"),
    // Business expenses (never Meta spend — see business_expenses'
    // own migration) — ALL-TIME for the trend table, feeding
    // buildMonthlyMetrics exactly like allPaidPaymentsRes/allWonEventsRes
    // above.
    supabase.from("business_expenses").select("amount_minor, expense_date"),

    // ---- Monthly Business Report — everything scoped to
    // selectedMonth, that buildMonthlyMetrics/the queries above don't
    // already cover. ----
    supabase
      .from("business_expenses")
      .select("id, expense_date, amount_minor, category, description")
      .gte("expense_date", selectedMonth.startDate)
      .lte("expense_date", selectedMonth.endDate)
      .order("expense_date", { ascending: false }),
    supabase
      .from("payments")
      .select("amount, purchase_id, purchase:purchases(service_type, customer_id)")
      .eq("status", "PAID")
      .gte("paid_at", selectedMonth.startDate)
      .lte("paid_at", selectedMonth.endDate),
    // Full touchpoint shape (is_primary + created_at) needed for lead-
    // source attribution — allLeadsWithTouchpointsRes above only carries
    // channel/certainty (all it needs for the trend table).
    supabase
      .from("leads")
      .select("id, touchpoints(channel, certainty, is_primary, created_at)")
      .gte("created_at", selectedMonth.startTimestamp)
      .lt("created_at", selectedMonth.endTimestampExclusive),
    supabase
      .from("lead_stage_events")
      .select("lead_id")
      .eq("to_stage", "LOST")
      .gte("changed_at", selectedMonth.startTimestamp)
      .lt("changed_at", selectedMonth.endTimestampExclusive),
    supabase
      .from("customers")
      .select("id", { count: "exact", head: true })
      .gte("customer_since", selectedMonth.startDate)
      .lte("customer_since", selectedMonth.endDate),
    // Referrals — direct only, never recursive (see referrals.ts's own
    // reasoning). ALL-TIME: the "ever referred" customer set for the
    // revenue figure needs every referral regardless of when it
    // happened, exactly like confirmedMetaPurchaseIds above is global
    // while only its resulting revenue is month-scoped.
    supabase.from("referrals").select("created_at, referred_contact_id"),
    supabase.from("customers").select("id, contact_id"),
  ]);

  // Meta spend + campaign table for the selected range.
  const metaRows = (metaMetricsRes.data ?? []) as unknown as MetaDailyRow[];
  const metaSpendMinor = metaRows.reduce((s, r) => s + r.spend_minor, 0);
  const metaAccountIds = [...new Set(metaRows.map((r) => r.meta_ad_account_id))];
  const campaigns = aggregateCampaignTotals(metaRows);

  // New leads + Meta attribution classification for the selected range.
  const leadsInRange = (leadsInRangeWithTouchpointsRes.data ?? []) as unknown as {
    id: string;
    touchpoints: LeadTouchpointForAttribution[];
  }[];
  const newLeadsCount = leadsInRange.length;
  let confirmedMetaLeadsCount = 0;
  let broadMetaLeadsCount = 0;
  for (const lead of leadsInRange) {
    const classification = classifyLeadAttribution(lead.touchpoints ?? []);
    if (classification === "CONFIRMED_META") confirmedMetaLeadsCount += 1;
    else if (classification === "BROAD_META") broadMetaLeadsCount += 1;
  }
  const metaAttributedLeadsCount = confirmedMetaLeadsCount + broadMetaLeadsCount;

  const metaSpendNis = metaSpendMinor / 100;
  const primaryCplNis = safeDivide(metaSpendNis, confirmedMetaLeadsCount);
  const primaryCplMinor = primaryCplNis === null ? null : Math.round(primaryCplNis * 100);
  const secondaryCplNis = safeDivide(metaSpendNis, metaAttributedLeadsCount);
  const secondaryCplMinor = secondaryCplNis === null ? null : Math.round(secondaryCplNis * 100);

  // WON transitions in range (via stage history, not current stage).
  const wonInRangeCount = new Set(
    (wonEventsInRangeRes.data ?? []).map((e) => e.lead_id)
  ).size;

  // Actual revenue in range (real payments only — never list price).
  const revenueMinor = (revenuePaymentsInRangeRes.data ?? []).reduce(
    (s, p) => s + p.amount,
    0
  );
  const revenueToSpendRatio = safeDivide(revenueMinor, metaSpendMinor);

  // Confirmed-Meta-attributed revenue: trace CONFIRMED META_AD leads ->
  // their purchases (purchases.lead_id, set once at WON conversion) ->
  // PAID payments on those purchases within the range. Schema supports
  // this unambiguously (one lead_id per purchase); if no confirmed-Meta
  // leads exist at all, the UI shows "not yet reliably measurable"
  // rather than a fabricated 0/0 ratio.
  const confirmedMetaLeadIds = [
    ...new Set((confirmedMetaTouchpointsRes.data ?? []).map((t) => t.lead_id)),
  ];
  const confirmedMetaLeadsExistOverall = confirmedMetaLeadIds.length > 0;
  // Purchase ids for confirmed-Meta leads — computed once, ALL-TIME (not
  // range-scoped), then reused for both the selected-range card and the
  // monthly breakdown below, so a purchase/payment is recognized as
  // confirmed-Meta-attributed regardless of which range happens to be
  // selected right now.
  let confirmedMetaPurchaseIds: string[] = [];
  if (confirmedMetaLeadsExistOverall) {
    const { data: purchasesForConfirmedLeads } = await supabase
      .from("purchases")
      .select("id")
      .in("lead_id", confirmedMetaLeadIds);
    confirmedMetaPurchaseIds = (purchasesForConfirmedLeads ?? []).map((p) => p.id);
  }
  const confirmedMetaPurchaseIdSet = new Set(confirmedMetaPurchaseIds);
  const confirmedMetaRevenueMinor = (revenuePaymentsInRangeRes.data ?? []).reduce(
    (s, p) => (confirmedMetaPurchaseIdSet.has(p.purchase_id) ? s + p.amount : s),
    0
  );
  const confirmedMetaRoas = confirmedMetaLeadsExistOverall
    ? safeDivide(confirmedMetaRevenueMinor, metaSpendMinor)
    : null;

  // Monthly performance — real calendar months, all-time history (not
  // cut at the currently-selected range), same attribution/formula
  // rules as the range-scoped section above.
  const monthlyMetrics = buildMonthlyMetrics({
    metaRows: (allMetaRowsRes.data ?? []) as unknown as MetaDailyRow[],
    leads: (allLeadsWithTouchpointsRes.data ?? []) as unknown as {
      id: string;
      created_at: string;
      touchpoints: LeadTouchpointForAttribution[];
    }[],
    wonEvents: allWonEventsRes.data ?? [],
    payments: allPaidPaymentsRes.data ?? [],
    confirmedMetaPurchaseIds,
    businessExpenses: allBusinessExpensesRes.data ?? [],
    currentMonthKey: currentMonthKey(),
    monthKeyOf,
    previousMonthKeyOf,
    formatMonthLabel,
  });

  // ================================================================
  // Monthly Business Report (selectedMonth) — reuses the SAME
  // buildMonthlyMetrics row computed above for the selected month
  // (revenue/Meta spend/expenses/profit/won/newLeads + their MoM
  // comparisons, all already correctly null-guarded for an unsynced
  // month or a partial current month) rather than recomputing any of
  // that separately. Only what buildMonthlyMetrics doesn't cover is
  // computed fresh below: lost-events, new-customers, revenue-by-
  // service, lead-sources, referral metrics, and the raw expense list.
  // ================================================================

  const selectedMonthRow: MonthlyMetrics =
    monthlyMetrics.find((m) => m.monthKey === selectedMonth.key) ?? {
      monthKey: selectedMonth.key,
      label: selectedMonth.label,
      isCurrentMonth: selectedMonth.isCurrentMonth,
      metaSpendMinor: null,
      newLeadsCount: 0,
      metaAttributedLeadsCount: 0,
      confirmedMetaLeadsCount: 0,
      broadMetaLeadsCount: 0,
      wonCount: 0,
      revenueMinor: 0,
      primaryCplMinor: null,
      revenueToSpendRatio: null,
      confirmedMetaRevenueMinor: 0,
      confirmedMetaRoas: null,
      otherExpensesMinor: 0,
      totalExpensesMinor: null,
      estimatedProfitMinor: null,
      changeVsPreviousMonth: {
        metaSpend: null,
        newLeads: null,
        won: null,
        revenue: null,
        otherExpenses: null,
        totalExpenses: null,
        estimatedProfit: null,
      },
    };

  // WON leads in the selected month that are ALSO confirmed-Meta-
  // attributed — "customers/WON attributable to Meta where reliably
  // traceable" (item 4). Reuses allWonEventsRes (already fetched
  // all-time) filtered to this month, cross-referenced against the
  // SAME confirmedMetaLeadIds computed above for the whole page.
  const wonLeadIdsInMonth = (allWonEventsRes.data ?? [])
    .filter((e) => monthKeyOf(e.changed_at) === selectedMonth.key)
    .map((e) => e.lead_id);
  const confirmedMetaLeadIdSet = new Set(confirmedMetaLeadIds);
  const metaAttributedWonCount = new Set(
    wonLeadIdsInMonth.filter((id) => confirmedMetaLeadIdSet.has(id))
  ).size;

  // Sales funnel — see lib/crm/business-report.ts's own doc comment
  // for the precise, deliberately-chosen definition of every figure
  // here (especially conversionRatePercent — NOT newLeads-based).
  const lostLeadIdsInMonth = (lostEventsInMonthRes.data ?? []).map((e) => e.lead_id);
  const salesFunnel = buildMonthlySalesFunnel({
    newLeadsCount: selectedMonthRow.newLeadsCount,
    wonLeadIds: wonLeadIdsInMonth,
    lostLeadIds: lostLeadIdsInMonth,
    newCustomersCount: newCustomersInMonthRes.count ?? 0,
  });

  // Revenue by service — reconciles exactly to selectedMonthRow.revenueMinor
  // by construction (same PAID/paid_at-in-month payment set).
  const paymentsInMonthWithService = (paymentsInMonthWithServiceRes.data ??
    []) as unknown as {
    amount: number;
    purchase_id: string;
    purchase: { service_type: ServiceType; customer_id: string } | null;
  }[];
  const revenueByService = aggregateRevenueByService(paymentsInMonthWithService);

  // Lead sources — one bucket per Lead, primary-touchpoint-first (see
  // aggregateLeadSources's own doc comment for the full rule).
  const leadsInMonthForSources = (leadsInMonthWithFullTouchpointsRes.data ??
    []) as unknown as {
    id: string;
    touchpoints: { channel: TouchpointChannel; certainty: string; is_primary: boolean; created_at: string }[];
  }[];
  const leadSources = aggregateLeadSources(leadsInMonthForSources);

  // Referral metrics — direct only, never recursive (see
  // buildMonthlyReferralMetrics's own doc comment).
  const contactIdToCustomerId = new Map(
    (allCustomersContactMapRes.data ?? []).map((c) => [c.contact_id, c.id])
  );
  const referralMetrics = buildMonthlyReferralMetrics({
    allReferrals: allReferralsRes.data ?? [],
    contactIdToCustomerId,
    paymentsInMonth: paymentsInMonthWithService.map((p) => ({
      amount: p.amount,
      customerId: p.purchase?.customer_id ?? null,
    })),
    monthKey: selectedMonth.key,
    monthKeyOf,
  });

  const businessReportData: BusinessReportData = {
    selectedMonth,
    revenueMinor: selectedMonthRow.revenueMinor,
    metaSpendMinor: selectedMonthRow.metaSpendMinor,
    otherExpensesMinor: selectedMonthRow.otherExpensesMinor,
    totalExpensesMinor: selectedMonthRow.totalExpensesMinor,
    estimatedProfitMinor: selectedMonthRow.estimatedProfitMinor,
    changeVsPreviousMonth: selectedMonthRow.changeVsPreviousMonth,
    salesFunnel,
    confirmedMetaLeadsCount: selectedMonthRow.confirmedMetaLeadsCount,
    broadMetaLeadsCount: selectedMonthRow.broadMetaLeadsCount,
    metaAttributedLeadsCount: selectedMonthRow.metaAttributedLeadsCount,
    primaryCplMinor: selectedMonthRow.primaryCplMinor,
    confirmedMetaRevenueMinor: selectedMonthRow.confirmedMetaRevenueMinor,
    confirmedMetaRoas: selectedMonthRow.confirmedMetaRoas,
    confirmedMetaLeadsExistOverall,
    metaAttributedWonCount,
    revenueByService,
    leadSources,
    referralMetrics,
    expenses: (businessExpensesInMonthRes.data ?? []) as BusinessReportData["expenses"],
  };

  const marketingData: MarketingPerformanceData = {
    range,
    metaSpendMinor,
    metaAccountIds,
    newLeadsCount,
    metaAttributedLeadsCount,
    confirmedMetaLeadsCount,
    broadMetaLeadsCount,
    primaryCplMinor,
    secondaryCplMinor,
    wonCount: wonInRangeCount,
    revenueMinor,
    revenueToSpendRatio,
    confirmedMetaLeadsExistOverall,
    confirmedMetaRevenueMinor,
    confirmedMetaRoas,
    campaigns,
  };

  const recentLeads = (recentLeadsRes.data ?? []) as unknown as RecentLead[];
  const upcomingFollowUps = (upcomingFollowUpsRes.data ??
    []) as unknown as UpcomingFollowUp[];
  const recentPayments = (recentPaymentsRes.data ??
    []) as unknown as RecentPayment[];

  return (
    <div>
      <PageHeader
        title="לוח בקרה"
        description="דוח עסקי חודשי, מעקבים ותמונת מצב חיה."
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard
          label="לידים חדשים (ממתינים)"
          value={String(newLeadsRes.count ?? 0)}
          icon={UserPlus}
          tone="accent"
        />
        <StatCard
          label="מעקבים לביצוע"
          value={String(followUpsDueRes.count ?? 0)}
          icon={Clock}
        />
        <StatCard
          label="אימוני ניסיון שנקבעו"
          value={String(trialsBookedRes.count ?? 0)}
          icon={Dumbbell}
        />
      </div>

      <div className="mt-8">
        <BusinessReport data={businessReportData} />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader
            title="לידים אחרונים"
            action={
              <Link
                href="/leads"
                className="flex items-center gap-1 text-xs font-medium text-rose-600 hover:text-rose-700"
              >
                לכל הלידים <ArrowLeft className="h-3.5 w-3.5" />
              </Link>
            }
          />
          {recentLeads.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={UserPlus}
                title="עדיין אין לידים"
                description="פניות חדשות יופיעו כאן ברגע שיתווספו."
              />
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {recentLeads.map((lead) => (
                <li key={lead.id}>
                  <Link
                    href={`/leads/${lead.id}`}
                    className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-zinc-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-900">
                        {lead.contact?.full_name ?? "איש קשר לא ידוע"}
                      </p>
                      <p className="truncate text-xs text-zinc-500">
                        {lead.interested_services.length > 0
                          ? lead.interested_services
                              .map((s) => SERVICE_TYPE_LABELS[s.service_type])
                              .join(", ")
                          : "לא צוין שירות"}{" "}
                        · {formatDate(lead.created_at)}
                      </p>
                    </div>
                    <Badge tone={LEAD_STAGE_TONE[lead.stage]}>
                      {LEAD_STAGE_LABELS[lead.stage]}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="מעקבים קרובים"
            action={
              <Link
                href="/follow-ups"
                className="flex items-center gap-1 text-xs font-medium text-rose-600 hover:text-rose-700"
              >
                לכל המעקבים <ArrowLeft className="h-3.5 w-3.5" />
              </Link>
            }
          />
          {upcomingFollowUps.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={Clock}
                title="שום דבר לא מתוכנן"
                description="מעקבים שתיצרי יופיעו כאן, מהקרוב ביותר."
              />
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {upcomingFollowUps.map((task) => {
                const overdue = new Date(task.due_at) < new Date();
                const name =
                  task.lead?.contact?.full_name ??
                  task.customer?.contact?.full_name ??
                  "לא ידוע";
                const href = task.lead
                  ? `/leads/${task.lead.id}`
                  : task.customer
                    ? `/customers/${task.customer.id}`
                    : undefined;
                const row = (
                  <>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-900">
                        {task.title}
                      </p>
                      <p className="truncate text-xs text-zinc-500">{name}</p>
                    </div>
                    <span
                      className={`shrink-0 text-xs font-medium ${
                        overdue ? "text-red-600" : "text-zinc-500"
                      }`}
                    >
                      {formatRelative(task.due_at)}
                    </span>
                  </>
                );
                return (
                  <li key={task.id}>
                    {href ? (
                      <Link
                        href={href}
                        className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-zinc-50"
                      >
                        {row}
                      </Link>
                    ) : (
                      <div className="flex items-center justify-between gap-3 px-5 py-3">
                        {row}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="תשלומים אחרונים"
            action={
              <Link
                href="/payments"
                className="flex items-center gap-1 text-xs font-medium text-rose-600 hover:text-rose-700"
              >
                לכל התשלומים <ArrowLeft className="h-3.5 w-3.5" />
              </Link>
            }
          />
          {recentPayments.length === 0 ? (
            <div className="p-5">
              <EmptyState
                icon={Wallet}
                title="עדיין אין תשלומים"
                description="תשלומים שיירשמו יופיעו כאן, מהאחרון ביותר."
              />
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {recentPayments.map((payment) => {
                const serviceLabel =
                  payment.purchase?.custom_service_name ??
                  (payment.purchase
                    ? SERVICE_TYPE_LABELS[payment.purchase.service_type]
                    : "שירות לא ידוע");
                const customer = payment.purchase?.customer;
                const row = (
                  <>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-900">
                        {customer?.contact?.full_name ?? "לקוחה לא ידועה"}
                      </p>
                      <p className="truncate text-xs text-zinc-500">
                        {serviceLabel} · {formatDate(payment.paid_at)}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold text-zinc-900">
                      {formatMoney(payment.amount, payment.currency)}
                    </span>
                  </>
                );
                return (
                  <li key={payment.id}>
                    {customer ? (
                      <Link
                        href={`/customers/${customer.id}`}
                        className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-zinc-50"
                      >
                        {row}
                      </Link>
                    ) : (
                      <div className="flex items-center justify-between gap-3 px-5 py-3">
                        {row}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <div id="marketing">
        <MarketingPerformance data={marketingData} />
        <MonthlyPerformance months={monthlyMetrics} />
      </div>
    </div>
  );
}
