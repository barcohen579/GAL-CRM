import type { Metadata } from "next";
import Link from "next/link";
import {
  UserPlus,
  Clock,
  Dumbbell,
  Trophy,
  Wallet,
  Percent,
  UserCheck,
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
import { FinancialSummary, type FinancialSummaryData } from "@/components/dashboard/business-report";
import { MonthSelector } from "@/components/dashboard/month-selector";
import {
  LEAD_STAGE_LABELS,
  LEAD_STAGE_TONE,
  SERVICE_TYPE_LABELS,
} from "@/lib/crm/constants";
import { formatDate, formatMoney, formatRelative } from "@/lib/crm/format";
import { filterActionableFollowUps } from "@/lib/crm/follow-up-visibility";
import {
  resolveSelectedMonth,
  currentMonthKey,
  monthKeyOf,
  previousMonthKeyOf,
  formatMonthLabel,
} from "@/lib/crm/date-range";
import {
  aggregateCampaignTotals,
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
  aggregateExpensesByCategory,
} from "@/lib/crm/business-report";
import type { RecurringExpenseRow } from "@/components/dashboard/recurring-expenses-manager";
import type {
  LeadStage,
  ServiceType,
  TouchpointChannel,
  BusinessExpenseCategory,
} from "@/lib/crm/constants";

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
  source: string;
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
  searchParams: Promise<{ month?: string }>;
}) {
  const { month: monthParam } = await searchParams;
  // The selected month is the SINGLE time context for the entire
  // dashboard — every month-dependent section below (KPI row,
  // Marketing, the financial report) reads from this one value. There
  // is no second independent date range anywhere on this page.
  const selectedMonth = resolveSelectedMonth(monthParam);

  const supabase = await createClient();
  const nowIso = new Date().toISOString();

  const [
    allPendingFollowUpsRes,
    trialsBookedRes,
    recentLeadsRes,
    recentPaymentsRes,
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
    recurringExpensesRes,
  ] = await Promise.all([
    // Fetches every PENDING follow-up (not just "due now" or a limited
    // page) with the (source, lead id) each row needs, so the
    // Automatic Lead Follow-Up Escalation Loop's actionable-visibility
    // rule (lib/crm/follow-up-visibility.ts) can be applied correctly —
    // it must see the FULL pending set for a lead to know whether a
    // competing manual follow-up exists, not just whichever page/slice
    // a narrower query happened to return. Both the "מעקבים לביצוע"
    // stat (due now) and the "מעקבים קרובים" list (top 5 upcoming)
    // below are derived from this single fetch.
    supabase
      .from("follow_up_tasks")
      .select(
        "id, title, due_at, source, lead:leads(id, contact:contacts(full_name)), customer:customers(id, contact:contacts(full_name))"
      )
      .eq("status", "PENDING")
      .order("due_at", { ascending: true }),
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
      .from("payments")
      .select(
        "id, amount, currency, paid_at, purchase:purchases(service_type, custom_service_name, customer:customers(id, contact:contacts(full_name)))"
      )
      .eq("status", "PAID")
      .order("paid_at", { ascending: false })
      .limit(5),

    // Global (not month-scoped): whether ANY confirmed-Meta lead exists
    // at all — a lead's confirmed attribution is a fixed property, not
    // itself date-ranged; only the resulting revenue is month-filtered
    // (via buildMonthlyMetrics below).
    supabase
      .from("touchpoints")
      .select("lead_id")
      .eq("channel", "META_AD")
      .eq("certainty", "CONFIRMED"),

    // ---- Fetched ALL-TIME (not just the selected month): feeds both
    // the historical trend table AND, filtered down to selectedMonth in
    // JS below, every Marketing/KPI figure for the selected month —
    // the dashboard's single time context. One fetch, no separate
    // range-scoped queries. ----
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
      .select("id, expense_date, amount_minor, category, description, recurring_expense_id")
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
    // Recurring expense DEFINITIONS ("הוצאות קבועות") — not month-scoped
    // (a recurring series isn't a dated event), active ones first so
    // the management card leads with what's currently running.
    supabase
      .from("business_recurring_expenses")
      .select("id, description, category, amount_minor, status")
      .order("status", { ascending: true })
      .order("created_at", { ascending: false }),
  ]);

  // Confirmed-Meta-attributed revenue traces CONFIRMED META_AD leads ->
  // their purchases (purchases.lead_id, set once at WON conversion) ->
  // PAID payments on those purchases. Schema supports this
  // unambiguously (one lead_id per purchase); if no confirmed-Meta
  // leads exist at all, the UI shows "not yet reliably measurable"
  // rather than a fabricated 0/0 ratio. Computed once, ALL-TIME (a
  // lead's confirmed attribution is a fixed property, not itself
  // date-ranged), then fed into buildMonthlyMetrics below so every
  // month's row — including the selected one — recognizes the same
  // purchases as confirmed-Meta-attributed.
  const confirmedMetaLeadIds = [
    ...new Set((confirmedMetaTouchpointsRes.data ?? []).map((t) => t.lead_id)),
  ];
  const confirmedMetaLeadsExistOverall = confirmedMetaLeadIds.length > 0;
  let confirmedMetaPurchaseIds: string[] = [];
  if (confirmedMetaLeadsExistOverall) {
    const { data: purchasesForConfirmedLeads } = await supabase
      .from("purchases")
      .select("id")
      .in("lead_id", confirmedMetaLeadIds);
    confirmedMetaPurchaseIds = (purchasesForConfirmedLeads ?? []).map((p) => p.id);
  }

  // Real calendar months, all-time history — one calculation feeds both
  // the compact historical trend table AND (via selectedMonthRow below)
  // every month-dependent figure on the rest of the page. This is the
  // dashboard's single source of truth for "what happened in month X":
  // there is no second, independently-scoped calculation anywhere else.
  const allMetaRows = (allMetaRowsRes.data ?? []) as unknown as MetaDailyRow[];
  const monthlyMetrics = buildMonthlyMetrics({
    metaRows: allMetaRows,
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

  // Campaign-level breakdown + synced-account count for the Marketing
  // section — sliced from the SAME all-time Meta rows above down to the
  // selected month, rather than a separate query with its own range.
  const monthMetaRows = allMetaRows.filter((r) => monthKeyOf(r.metric_date) === selectedMonth.key);
  const metaAccountIds = [...new Set(monthMetaRows.map((r) => r.meta_ad_account_id))];
  const campaigns = aggregateCampaignTotals(monthMetaRows);

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

  // Expenses by category ("הוצאות לפי קטגוריה") — reconciles exactly to
  // selectedMonthRow.otherExpensesMinor by construction (same
  // expense_date-in-month row set businessExpensesInMonthRes already
  // fetched for the ledger list below).
  const businessExpensesInMonth = (businessExpensesInMonthRes.data ?? []) as unknown as {
    amount_minor: number;
    category: BusinessExpenseCategory;
  }[];
  const expensesByCategory = aggregateExpensesByCategory(businessExpensesInMonth);

  // Recurring expense definitions — not month-scoped, see the query's
  // own comment above.
  const recurringExpenses = (recurringExpensesRes.data ?? []) as unknown as RecurringExpenseRow[];

  const financialSummaryData: FinancialSummaryData = {
    revenueMinor: selectedMonthRow.revenueMinor,
    metaSpendMinor: selectedMonthRow.metaSpendMinor,
    otherExpensesMinor: selectedMonthRow.otherExpensesMinor,
    totalExpensesMinor: selectedMonthRow.totalExpensesMinor,
    estimatedProfitMinor: selectedMonthRow.estimatedProfitMinor,
    changeVsPreviousMonth: selectedMonthRow.changeVsPreviousMonth,
    revenueByService,
    leadSources,
    referralMetrics,
    expensesByCategory,
    recurringExpenses,
    expenses: (businessExpensesInMonthRes.data ?? []) as FinancialSummaryData["expenses"],
  };

  // Marketing section data — entirely selectedMonthRow (already computed
  // by buildMonthlyMetrics above for exactly this month) plus the two
  // fields that row doesn't carry: the campaign table/account count
  // (sliced from all-time Meta rows just above) and metaAttributedWonCount
  // (computed just above too). No independent range anywhere here.
  const marketingData: MarketingPerformanceData = {
    monthLabel: selectedMonth.label,
    metaSpendMinor: selectedMonthRow.metaSpendMinor,
    metaAccountIds,
    newLeadsCount: selectedMonthRow.newLeadsCount,
    metaAttributedLeadsCount: selectedMonthRow.metaAttributedLeadsCount,
    confirmedMetaLeadsCount: selectedMonthRow.confirmedMetaLeadsCount,
    broadMetaLeadsCount: selectedMonthRow.broadMetaLeadsCount,
    primaryCplMinor: selectedMonthRow.primaryCplMinor,
    metaAttributedWonCount,
    revenueToSpendRatio: selectedMonthRow.revenueToSpendRatio,
    confirmedMetaLeadsExistOverall,
    confirmedMetaRevenueMinor: selectedMonthRow.confirmedMetaRevenueMinor,
    confirmedMetaRoas: selectedMonthRow.confirmedMetaRoas,
    campaigns,
  };

  const recentLeads = (recentLeadsRes.data ?? []) as unknown as RecentLead[];
  const recentPayments = (recentPaymentsRes.data ??
    []) as unknown as RecentPayment[];

  // Actionable-visibility rule (Automatic Lead Follow-Up Escalation
  // Loop): a lead with an active MANUAL follow-up counts/shows only
  // that one here, never a second, competing AUTOMATIC row for the
  // same lead — see lib/crm/follow-up-visibility.ts. Applied against
  // the FULL pending set fetched above, then split into the "due now"
  // stat and the top-5 "upcoming" list.
  const actionablePendingFollowUps = filterActionableFollowUps(
    (allPendingFollowUpsRes.data ?? []) as unknown as UpcomingFollowUp[],
    (t) => ({ source: t.source, status: "PENDING", leadId: t.lead?.id ?? null })
  );
  const followUpsDueCount = actionablePendingFollowUps.filter((t) => t.due_at <= nowIso).length;
  const upcomingFollowUps = actionablePendingFollowUps.slice(0, 5);

  return (
    <div>
      <PageHeader
        title="לוח בקרה"
        description="תמונת מצב חיה של לידים, מעקבים והכנסות."
        action={
          <div className="flex flex-col items-end gap-1.5">
            <span className="text-xs font-medium text-zinc-500">חודש להצגה</span>
            <MonthSelector selectedMonth={selectedMonth} />
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="לידים חדשים בחודש"
          value={String(salesFunnel.newLeadsCount)}
          icon={UserPlus}
          tone="accent"
        />
        <StatCard
          label="מעקבים לביצוע"
          value={String(followUpsDueCount)}
          icon={Clock}
        />
        <StatCard
          label="אימוני ניסיון שנקבעו"
          value={String(trialsBookedRes.count ?? 0)}
          icon={Dumbbell}
        />
        <StatCard
          label="לקוחות חדשות בחודש"
          value={String(salesFunnel.newCustomersCount)}
          icon={UserCheck}
          hint="כולל לקוחות ישירות ללא ליד"
        />
        <StatCard
          label="נסגרו (WON)"
          value={String(salesFunnel.wonCount)}
          icon={Trophy}
        />
        <StatCard
          label="אחוז סגירה"
          value={
            salesFunnel.conversionRatePercent === null
              ? "—"
              : `${salesFunnel.conversionRatePercent.toFixed(0)}%`
          }
          icon={Percent}
          hint={
            salesFunnel.wonCount + salesFunnel.lostCount === 0
              ? "עדיין לא הוכרע אף ליד בחודש זה"
              : `${salesFunnel.wonCount} נסגרו מתוך ${salesFunnel.wonCount + salesFunnel.lostCount} שהוכרעו`
          }
        />
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

      <div id="marketing" className="mt-8">
        <MarketingPerformance data={marketingData} />
      </div>

      <div className="mt-8">
        <FinancialSummary data={financialSummaryData} />
      </div>

      {/* Compact historical trend — real calendar months, all-time.
          Deliberately last: it compares months rather than reporting on
          the selected one, so it stays a footer, never competing
          visually with the selected-month sections above. */}
      <div className="mt-8">
        <MonthlyPerformance months={monthlyMetrics} />
      </div>
    </div>
  );
}
