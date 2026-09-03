import Link from "next/link";
import {
  Wallet,
  Megaphone,
  Receipt,
  Calculator,
  TrendingUp,
  UserPlus,
  UserCheck,
  Trophy,
  Percent,
  Target,
  BadgeCheck,
  Coins,
  Users,
} from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { MonthSelector } from "./month-selector";
import { ExpenseList, type BusinessExpenseRow } from "./expense-list";
import { formatMoney } from "@/lib/crm/format";
import {
  SERVICE_TYPE_LABELS,
  TOUCHPOINT_CHANNEL_LABELS,
} from "@/lib/crm/constants";
import type { SelectedMonth } from "@/lib/crm/date-range";
import type { MonthOverMonthChange } from "@/lib/crm/marketing";
import type {
  ServiceRevenueRow,
  MonthlySalesFunnel,
  MonthlyReferralMetrics,
} from "@/lib/crm/business-report";
import type { TouchpointChannel } from "@/lib/crm/constants";

function formatRatio(ratio: number | null): string {
  if (ratio === null) return "—";
  return `×${ratio.toFixed(2)}`;
}

function ChangeBadge({ change }: { change: MonthOverMonthChange }) {
  if (change === null) return null;
  const sign = change.direction === "up" ? "↑" : change.direction === "down" ? "↓" : "";
  return (
    <span className="text-xs font-medium text-zinc-500">
      {sign} {Math.abs(change.percent).toFixed(0)}%
    </span>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  change,
  hint,
  unavailableText,
  accent,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  value: string | null;
  change?: MonthOverMonthChange;
  hint?: string;
  unavailableText?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-5 shadow-sm ${
        accent ? "border-rose-200 bg-rose-50/40" : "border-zinc-200 bg-white"
      }`}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500">
          <Icon className="h-4 w-4" strokeWidth={2} />
        </div>
      </div>
      {value === null ? (
        <p className="mt-3 text-sm text-zinc-400">{unavailableText}</p>
      ) : (
        <div className="mt-3 flex items-baseline gap-2">
          <p className="text-2xl font-semibold tracking-tight text-zinc-900">{value}</p>
          {change !== undefined && <ChangeBadge change={change} />}
        </div>
      )}
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

export type BusinessReportData = {
  selectedMonth: SelectedMonth;

  // Top KPIs — revenue / expenses / profit.
  revenueMinor: number;
  metaSpendMinor: number | null;
  otherExpensesMinor: number;
  totalExpensesMinor: number | null;
  estimatedProfitMinor: number | null;
  changeVsPreviousMonth: {
    revenue: MonthOverMonthChange;
    metaSpend: MonthOverMonthChange;
    otherExpenses: MonthOverMonthChange;
    totalExpenses: MonthOverMonthChange;
    estimatedProfit: MonthOverMonthChange;
    newLeads: MonthOverMonthChange;
    won: MonthOverMonthChange;
  };

  // Sales funnel.
  salesFunnel: MonthlySalesFunnel;

  // Marketing KPIs.
  confirmedMetaLeadsCount: number;
  broadMetaLeadsCount: number;
  metaAttributedLeadsCount: number;
  primaryCplMinor: number | null;
  confirmedMetaRevenueMinor: number;
  confirmedMetaRoas: number | null;
  confirmedMetaLeadsExistOverall: boolean;
  metaAttributedWonCount: number;

  revenueByService: ServiceRevenueRow[];
  leadSources: Record<TouchpointChannel, number>;
  referralMetrics: MonthlyReferralMetrics;
  expenses: BusinessExpenseRow[];
};

export function BusinessReport({ data }: { data: BusinessReportData }) {
  const {
    selectedMonth,
    revenueMinor,
    metaSpendMinor,
    otherExpensesMinor,
    totalExpensesMinor,
    estimatedProfitMinor,
    changeVsPreviousMonth: chg,
    salesFunnel,
    confirmedMetaLeadsCount,
    broadMetaLeadsCount,
    metaAttributedLeadsCount,
    primaryCplMinor,
    confirmedMetaRevenueMinor,
    confirmedMetaRoas,
    confirmedMetaLeadsExistOverall,
    metaAttributedWonCount,
    revenueByService,
    leadSources,
    referralMetrics,
    expenses,
  } = data;

  const totalLeadSources = Object.values(leadSources).reduce((a, b) => a + b, 0);
  const maxServiceRevenue = Math.max(1, ...revenueByService.map((r) => r.amountMinor));
  const maxLeadSourceCount = Math.max(1, ...Object.values(leadSources));

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-zinc-900">
            דוח עסקי חודשי
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            התמונה המלאה של החודש הנבחר — הכנסות, הוצאות, לידים ושיווק.
          </p>
        </div>
        <MonthSelector selectedMonth={selectedMonth} />
      </div>

      {/* ---- Revenue / expenses / profit ---- */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          icon={Wallet}
          label="הכנסות"
          value={formatMoney(revenueMinor)}
          change={chg.revenue}
          hint="תשלומים ששולמו בפועל בחודש זה"
          accent
        />
        <KpiCard
          icon={Megaphone}
          label="הוצאות פרסום"
          value={metaSpendMinor === null ? null : formatMoney(metaSpendMinor)}
          change={chg.metaSpend}
          unavailableText="אין נתוני סנכרון מטא לחודש זה"
        />
        <KpiCard
          icon={Receipt}
          label="הוצאות עסק"
          value={formatMoney(otherExpensesMinor)}
          change={chg.otherExpenses}
          hint="הוצאות שנרשמו ידנית"
        />
        <KpiCard
          icon={Calculator}
          label="סה״כ הוצאות"
          value={totalExpensesMinor === null ? null : formatMoney(totalExpensesMinor)}
          change={chg.totalExpenses}
          unavailableText="תלוי בהוצאת מטא — אין נתוני סנכרון"
          hint="הוצאת פרסום + הוצאות עסק"
        />
        <KpiCard
          icon={TrendingUp}
          label="רווח משוער"
          value={estimatedProfitMinor === null ? null : formatMoney(estimatedProfitMinor)}
          change={chg.estimatedProfit}
          unavailableText="תלוי בסה״כ הוצאות"
          hint="הכנסות פחות סה״כ הוצאות — מדד ניהולי, לא רווח חשבונאי (לא כולל מע״מ/מס הכנסה/ביטוח לאומי/פחת)"
        />
      </div>

      {/* ---- Sales funnel ---- */}
      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          icon={UserPlus}
          label="לידים חדשים"
          value={String(salesFunnel.newLeadsCount)}
          change={chg.newLeads}
          hint="לידים שנוצרו בחודש זה"
        />
        <KpiCard
          icon={UserCheck}
          label="לקוחות חדשות"
          value={String(salesFunnel.newCustomersCount)}
          hint="לקוחות מאז בחודש זה — כולל לקוחות ישירות ללא ליד"
        />
        <KpiCard
          icon={Trophy}
          label="לידים שנסגרו (WON)"
          value={String(salesFunnel.wonCount)}
          change={chg.won}
          hint="מעבר לשלב נסגרה בחודש זה"
        />
        <KpiCard
          icon={Percent}
          label="אחוז סגירה"
          value={
            salesFunnel.conversionRatePercent === null
              ? null
              : `${salesFunnel.conversionRatePercent.toFixed(0)}%`
          }
          unavailableText="עדיין לא הוכרע אף ליד החודש"
          hint={`מתוך לידים שהוכרעו החודש (${salesFunnel.wonCount} נסגרו / ${
            salesFunnel.wonCount + salesFunnel.lostCount
          } הוכרעו) — לא מתוך הלידים החדשים החודש`}
        />
      </div>

      {/* ---- Marketing KPIs ---- */}
      <div className="mt-6">
        <h3 className="mb-3 text-sm font-semibold text-zinc-900">שיווק — מטא</h3>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard
            icon={BadgeCheck}
            label="לידים מאומתים ממטא"
            value={String(confirmedMetaLeadsCount)}
            hint="ייחוס ודאי (CONFIRMED)"
          />
          <KpiCard
            icon={Target}
            label="לידים משויכים למטא (רחב)"
            value={String(metaAttributedLeadsCount)}
            hint={`כולל ${broadMetaLeadsCount} לא ודאיים`}
          />
          <KpiCard
            icon={TrendingUp}
            label="עלות לליד מאומת (CPL)"
            value={primaryCplMinor === null ? null : formatMoney(primaryCplMinor)}
            unavailableText="אין לידים מאומתים ממטא החודש"
          />
          <KpiCard
            icon={Trophy}
            label="WON משויכים למטא"
            value={String(metaAttributedWonCount)}
            hint="לידים עם ייחוס מאומת שנסגרו החודש"
          />
          <KpiCard
            icon={Coins}
            label="הכנסה מאומתת ממטא"
            value={formatMoney(confirmedMetaRevenueMinor)}
            hint="תשלומים בחודש זה מלידים עם ייחוס מאומת"
          />
          <KpiCard
            icon={TrendingUp}
            label="ROAS מאומת ממטא"
            value={confirmedMetaLeadsExistOverall ? formatRatio(confirmedMetaRoas) : null}
            unavailableText="עדיין לא ניתן למדידה אמינה"
            hint='לא לבלבל עם יחס הכנסות כלליות מול הוצאת מטא — זהו ROAS על הכנסה מאומתת בלבד'
          />
        </div>
      </div>

      {/* ---- Revenue by service + lead sources ---- */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="הכנסות לפי שירות"
            description={`סה״כ: ${formatMoney(revenueMinor)}`}
          />
          {revenueByService.every((r) => r.amountMinor === 0) ? (
            <div className="p-5">
              <EmptyState icon={Wallet} title="אין עדיין הכנסות לחודש זה" />
            </div>
          ) : (
            <ul className="space-y-3 px-5 py-4">
              {revenueByService
                .filter((r) => r.amountMinor > 0)
                .map((r) => (
                  <li key={r.serviceType}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-medium text-zinc-700">
                        {r.serviceType === "UNCLASSIFIED"
                          ? "לא מסווג"
                          : SERVICE_TYPE_LABELS[r.serviceType]}
                      </span>
                      <span className="font-semibold text-zinc-900">
                        {formatMoney(r.amountMinor)}
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100">
                      <div
                        className="h-full rounded-full bg-rose-500"
                        style={{ width: `${(r.amountMinor / maxServiceRevenue) * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="לידים לפי מקור"
            description={`סה״כ: ${totalLeadSources} לידים · ייחוס עיקרי בלבד לכל ליד`}
          />
          {totalLeadSources === 0 ? (
            <div className="p-5">
              <EmptyState icon={Target} title="אין עדיין לידים לחודש זה" />
            </div>
          ) : (
            <ul className="space-y-3 px-5 py-4">
              {(Object.entries(leadSources) as [TouchpointChannel, number][])
                .filter(([, count]) => count > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([channel, count]) => (
                  <li key={channel}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-medium text-zinc-700">
                        {TOUCHPOINT_CHANNEL_LABELS[channel]}
                      </span>
                      <span className="font-semibold text-zinc-900">{count}</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100">
                      <div
                        className="h-full rounded-full bg-sky-500"
                        style={{ width: `${(count / maxLeadSourceCount) * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </Card>
      </div>

      {/* ---- Referrals + expenses ---- */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="המלצות"
            description="הפניה ישירה בלבד — לא כולל עץ הפניות רקורסיבי"
          />
          <div className="grid grid-cols-3 gap-3 px-5 py-4 text-center">
            <div>
              <p className="text-2xl font-semibold text-zinc-900">
                {referralMetrics.referredCount}
              </p>
              <p className="mt-1 flex items-center justify-center gap-1 text-xs text-zinc-500">
                <Users className="h-3 w-3" /> הופנו החודש
              </p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-zinc-900">
                {referralMetrics.becameCustomerCount}
              </p>
              <p className="mt-1 text-xs text-zinc-500">הפכו ללקוחות</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-zinc-900">
                {formatMoney(referralMetrics.revenueMinor)}
              </p>
              <p className="mt-1 text-xs text-zinc-500">הכנסה החודש מהפניות</p>
            </div>
          </div>
          <p className="border-t border-zinc-100 px-5 py-3 text-xs text-zinc-500">
            הכנסת ההפניות כוללת תשלומים החודש מכל לקוחה שהופנתה אי פעם — לא רק
            הפניות מהחודש הזה. לא מוצג כ-LTV.
          </p>
        </Card>

        <ExpenseList expenses={expenses} totalMinor={otherExpensesMinor} />
      </div>

      <Link
        href="#marketing"
        className="mt-6 inline-block text-xs font-medium text-rose-600 hover:text-rose-700"
      >
        לביצועי שיווק גמישים לפי טווח ולפי קמפיין ↓
      </Link>
    </div>
  );
}
