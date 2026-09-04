import { Wallet, Megaphone, Receipt, Calculator, TrendingUp, Target, Users, PieChart } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ExpenseList, type BusinessExpenseRow } from "./expense-list";
import { RecurringExpensesManager, type RecurringExpenseRow } from "./recurring-expenses-manager";
import { formatMoney } from "@/lib/crm/format";
import {
  SERVICE_TYPE_LABELS,
  TOUCHPOINT_CHANNEL_LABELS,
  BUSINESS_EXPENSE_CATEGORY_LABELS,
} from "@/lib/crm/constants";
import type { MonthOverMonthChange } from "@/lib/crm/marketing";
import type {
  ServiceRevenueRow,
  MonthlyReferralMetrics,
  ExpenseCategoryRow,
} from "@/lib/crm/business-report";
import type { TouchpointChannel } from "@/lib/crm/constants";

// Shared presentational building blocks — also used by
// monthly-marketing-kpis.tsx, so exported rather than duplicated.
export function formatRatio(ratio: number | null): string {
  if (ratio === null) return "—";
  return `×${ratio.toFixed(2)}`;
}

export function ChangeBadge({ change }: { change: MonthOverMonthChange }) {
  if (change === null) return null;
  const sign = change.direction === "up" ? "↑" : change.direction === "down" ? "↓" : "";
  return (
    <span className="text-xs font-medium text-zinc-500">
      {sign} {Math.abs(change.percent).toFixed(0)}%
    </span>
  );
}

export function KpiCard({
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

// The financial/business-summary section — revenue, Meta spend,
// business expenses, total expenses, estimated profit, revenue by
// service, lead sources, referral revenue, and the expense list.
// Deliberately placed toward the END of /dashboard (see page.tsx) —
// leads/sales/marketing performance keep their pre-existing position
// near the top; this is the newer, deeper financial drill-down for the
// selected month, not the page's headline. The sales-funnel KPIs
// (new leads/new customers/WON/conversion) and the Meta-specific KPI
// grid (see monthly-marketing-kpis.tsx) live elsewhere on the page —
// this component covers only what's genuinely new-and-financial.
export type FinancialSummaryData = {
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
  };
  revenueByService: ServiceRevenueRow[];
  leadSources: Record<TouchpointChannel, number>;
  referralMetrics: MonthlyReferralMetrics;
  expensesByCategory: ExpenseCategoryRow[];
  recurringExpenses: RecurringExpenseRow[];
  expenses: BusinessExpenseRow[];
};

export function FinancialSummary({ data }: { data: FinancialSummaryData }) {
  const {
    revenueMinor,
    metaSpendMinor,
    otherExpensesMinor,
    totalExpensesMinor,
    estimatedProfitMinor,
    changeVsPreviousMonth: chg,
    revenueByService,
    leadSources,
    referralMetrics,
    expensesByCategory,
    recurringExpenses,
    expenses,
  } = data;

  const totalLeadSources = Object.values(leadSources).reduce((a, b) => a + b, 0);
  const maxServiceRevenue = Math.max(1, ...revenueByService.map((r) => r.amountMinor));
  const maxLeadSourceCount = Math.max(1, ...Object.values(leadSources));
  const totalExpensesByCategory = expensesByCategory.reduce((a, r) => a + r.amountMinor, 0);
  const maxExpenseCategory = Math.max(1, ...expensesByCategory.map((r) => r.amountMinor));

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-semibold tracking-tight text-zinc-900">
          הכנסות, הוצאות ורווח
        </h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          הפירוט הכספי המלא של החודש הנבחר — כולל הוצאות שנרשמו ידנית.
        </p>
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

      {/* ---- Where the money went: expenses by category + the
          recurring-expense series manager ---- */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="הוצאות לפי קטגוריה"
            description={`סה״כ: ${formatMoney(totalExpensesByCategory)}`}
          />
          {expensesByCategory.length === 0 ? (
            <div className="p-5">
              <EmptyState icon={PieChart} title="אין עדיין הוצאות עסק לחודש זה" />
            </div>
          ) : (
            <ul className="space-y-3 px-5 py-4">
              {expensesByCategory.map((r) => (
                <li key={r.category}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium text-zinc-700">
                      {BUSINESS_EXPENSE_CATEGORY_LABELS[r.category] ?? r.category}
                    </span>
                    <span className="font-semibold text-zinc-900">
                      {formatMoney(r.amountMinor)}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100">
                    <div
                      className="h-full rounded-full bg-amber-500"
                      style={{ width: `${(r.amountMinor / maxExpenseCategory) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-zinc-100 px-5 py-3 text-xs text-zinc-500">
            הוצאות עסק ידניות וקבועות בלבד — הוצאת פרסום Meta מוצגת בנפרד למעלה
            ואינה כלולה כאן.
          </p>
        </Card>

        <RecurringExpensesManager recurringExpenses={recurringExpenses} />
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
    </div>
  );
}
