import { ArrowUp, ArrowDown, CalendarRange } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney } from "@/lib/crm/format";
import type { MonthlyMetrics, MonthOverMonthChange } from "@/lib/crm/marketing";

function formatRatio(ratio: number | null): string {
  if (ratio === null) return "—";
  return `×${ratio.toFixed(2)}`;
}

function ChangeBadge({ change }: { change: MonthOverMonthChange }) {
  if (change === null) {
    return <span className="text-xs text-zinc-400">—</span>;
  }
  const Icon = change.direction === "up" ? ArrowUp : ArrowDown;
  return (
    <span className="inline-flex items-center gap-0.5 text-xs font-medium text-zinc-500">
      {change.direction !== "flat" && <Icon className="h-3 w-3" strokeWidth={2.5} />}
      {Math.abs(change.percent).toFixed(0)}%
    </span>
  );
}

export function MonthlyPerformance({ months }: { months: MonthlyMetrics[] }) {
  return (
    <Card className="mt-6">
      <CardHeader
        title="ביצועים חודשיים"
        description="השוואת עסק ושיווק לפי חודש קלנדרי — לא חלון נגלל של 30 יום."
      />
      {months.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={CalendarRange}
            title="עדיין אין נתונים חודשיים"
            description="ברגע שיהיו לידים, הוצאת פרסום או תשלומים, החודשים יופיעו כאן."
          />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1320px] text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-xs text-zinc-500">
                <th className="px-5 py-2.5 text-start font-medium">חודש</th>
                <th className="px-5 py-2.5 text-end font-medium">הוצאת מטא</th>
                <th className="px-5 py-2.5 text-end font-medium">לידים חדשים</th>
                <th className="px-5 py-2.5 text-end font-medium">משויכים למטא</th>
                <th className="px-5 py-2.5 text-end font-medium">מאומתים ממטא</th>
                <th className="px-5 py-2.5 text-end font-medium">נסגרו (WON)</th>
                <th className="px-5 py-2.5 text-end font-medium">הכנסות בפועל</th>
                <th className="px-5 py-2.5 text-end font-medium">הוצאות עסק</th>
                <th className="px-5 py-2.5 text-end font-medium">סה״כ הוצאות</th>
                <th className="px-5 py-2.5 text-end font-medium">רווח משוער</th>
                <th className="px-5 py-2.5 text-end font-medium">CPL מאומת</th>
                <th className="px-5 py-2.5 text-end font-medium">הכנסה/הוצאה</th>
                <th className="px-5 py-2.5 text-end font-medium">ROAS מאומת</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {months.map((m) => (
                <tr key={m.monthKey}>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-zinc-900">{m.label}</span>
                      {m.isCurrentMonth && (
                        <Badge tone="info">חודש נוכחי · חלקי</Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-end">
                    <div>
                      {m.metaSpendMinor === null ? (
                        <span className="text-zinc-400">אין נתוני סנכרון</span>
                      ) : (
                        formatMoney(m.metaSpendMinor)
                      )}
                    </div>
                    <ChangeBadge change={m.changeVsPreviousMonth.metaSpend} />
                  </td>
                  <td className="px-5 py-3 text-end">
                    <div>{m.newLeadsCount}</div>
                    <ChangeBadge change={m.changeVsPreviousMonth.newLeads} />
                  </td>
                  <td className="px-5 py-3 text-end">{m.metaAttributedLeadsCount}</td>
                  <td className="px-5 py-3 text-end">{m.confirmedMetaLeadsCount}</td>
                  <td className="px-5 py-3 text-end">
                    <div>{m.wonCount}</div>
                    <ChangeBadge change={m.changeVsPreviousMonth.won} />
                  </td>
                  <td className="px-5 py-3 text-end">
                    <div>{formatMoney(m.revenueMinor)}</div>
                    <ChangeBadge change={m.changeVsPreviousMonth.revenue} />
                  </td>
                  <td className="px-5 py-3 text-end">
                    <div>{formatMoney(m.otherExpensesMinor)}</div>
                    <ChangeBadge change={m.changeVsPreviousMonth.otherExpenses} />
                  </td>
                  <td className="px-5 py-3 text-end">
                    {m.totalExpensesMinor === null ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      <div>{formatMoney(m.totalExpensesMinor)}</div>
                    )}
                    <ChangeBadge change={m.changeVsPreviousMonth.totalExpenses} />
                  </td>
                  <td className="px-5 py-3 text-end">
                    {m.estimatedProfitMinor === null ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      <div
                        className={
                          m.estimatedProfitMinor < 0 ? "font-medium text-red-600" : undefined
                        }
                      >
                        {formatMoney(m.estimatedProfitMinor)}
                      </div>
                    )}
                    <ChangeBadge change={m.changeVsPreviousMonth.estimatedProfit} />
                  </td>
                  <td className="px-5 py-3 text-end">
                    {m.primaryCplMinor === null ? (
                      <span className="text-xs text-zinc-400">אין מספיק נתונים</span>
                    ) : (
                      formatMoney(m.primaryCplMinor)
                    )}
                  </td>
                  <td className="px-5 py-3 text-end">
                    {m.revenueToSpendRatio === null ? (
                      <span className="text-xs text-zinc-400">—</span>
                    ) : (
                      formatRatio(m.revenueToSpendRatio)
                    )}
                  </td>
                  <td className="px-5 py-3 text-end">
                    {m.confirmedMetaRoas === null ? (
                      <span className="text-xs text-zinc-400">לא ניתן למדידה</span>
                    ) : (
                      formatRatio(m.confirmedMetaRoas)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-zinc-100 px-5 py-3 text-xs text-zinc-500">
        &quot;הכנסה/הוצאה&quot; הוא יחס כלל הכנסות העסק מול הוצאת מטא — לא ROAS של מטא. ROAS מאומת
        מוצג רק כאשר קיימים לידים עם ייחוס מאומת (CONFIRMED) ממטא. &quot;רווח משוער&quot; הוא מדד ניהולי
        (הכנסות פחות סה״כ הוצאות) — לא רווח חשבונאי, ואינו כולל מע״מ, מס הכנסה, ביטוח לאומי או פחת.
      </p>
    </Card>
  );
}
