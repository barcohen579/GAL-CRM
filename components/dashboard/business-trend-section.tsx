"use client";

import { useState } from "react";
import { ArrowUp, ArrowDown, Minus } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { formatMoney } from "@/lib/crm/format";
import type { CurrentPeriodBusinessSnapshot, MonthOverMonthChange } from "@/lib/crm/marketing";

// "מגמת העסק" — a hand-rolled inline-SVG line chart (revenue vs.
// expenses, last 6 real calendar months) plus the revenue-growth
// indicator. No charting dependency: this codebase has zero UI/design-
// system dependencies anywhere (every dialog/card/badge is hand-rolled
// with Tailwind + native elements), and 2 series over <=6 points doesn't
// warrant one. All the actual numbers come from lib/crm/marketing.ts —
// buildMonthlyMetrics (per-month totals, already the Dashboard's one
// authoritative revenue/expense calculation) and
// computeCurrentPeriodBusinessSnapshot (the current-partial-period-vs-
// same-range-last-month comparison) — this component only draws them.

export type TrendMonthPoint = {
  monthKey: string; // "YYYY-MM"
  isCurrentMonth: boolean;
  revenueMinor: number;
  /** null = Meta never synced this month (see MonthlyMetrics.totalExpensesMinor)
   *  — the expenses line breaks at this point rather than drawing a
   *  misleading 0. */
  totalExpensesMinor: number | null;
};

const CHART_WIDTH = 600;
const CHART_HEIGHT = 200;
const CHART_PADDING_X = 24;
const CHART_PADDING_TOP = 16;
const CHART_PADDING_BOTTOM = 26;

const shortMonthFormatter = new Intl.DateTimeFormat("he-IL", { month: "short" });
function shortMonthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return shortMonthFormatter.format(new Date(y, m - 1, 1));
}

function formatSigned(diffMinor: number): string {
  if (diffMinor === 0) return formatMoney(0);
  return `${diffMinor > 0 ? "+" : "-"}${formatMoney(Math.abs(diffMinor))}`;
}

function xForIndex(i: number, count: number): number {
  if (count <= 1) return CHART_WIDTH / 2;
  const usable = CHART_WIDTH - CHART_PADDING_X * 2;
  return CHART_PADDING_X + (usable * i) / (count - 1);
}

function buildPath(values: (number | null)[], count: number, yOf: (v: number) => number): string {
  let d = "";
  let drawing = false;
  values.forEach((v, i) => {
    if (v === null) {
      drawing = false;
      return;
    }
    const x = xForIndex(i, count);
    const y = yOf(v);
    d += drawing ? ` L ${x} ${y}` : `M ${x} ${y}`;
    drawing = true;
  });
  return d;
}

function GrowthMessage({ change, diffMinor }: { change: MonthOverMonthChange; diffMinor: number }) {
  if (change === null) {
    return (
      <p className="text-sm font-medium text-zinc-600">
        אין הכנסות מהתקופה המקבילה בחודש הקודם להשוואה
      </p>
    );
  }
  const color =
    change.direction === "up"
      ? "text-emerald-600"
      : change.direction === "down"
        ? "text-red-600"
        : "text-zinc-700";
  const Icon = change.direction === "up" ? ArrowUp : change.direction === "down" ? ArrowDown : Minus;
  const verb = change.direction === "up" ? "עלו" : change.direction === "down" ? "ירדו" : null;

  return (
    <div>
      <p className={`flex items-center gap-1.5 text-sm font-semibold ${color}`}>
        <Icon className="h-4 w-4" strokeWidth={2.5} />
        {verb
          ? `ההכנסות ${verb} ב-${Math.abs(change.percent).toFixed(1)}% לעומת אותה תקופה בחודש הקודם`
          : "ההכנסות ללא שינוי לעומת אותה תקופה בחודש הקודם"}
      </p>
      <p className={`mt-0.5 text-sm font-semibold ${color}`}>{formatSigned(diffMinor)}</p>
    </div>
  );
}

export function BusinessTrendSection({
  months,
  snapshot,
}: {
  months: TrendMonthPoint[];
  snapshot: CurrentPeriodBusinessSnapshot;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const revenueValues = months.map((m) => m.revenueMinor);
  const expenseValues = months.map((m) => m.totalExpensesMinor);
  const allValues = [...revenueValues, ...expenseValues.filter((v): v is number => v !== null)];
  const maxValue = Math.max(1, ...allValues); // never a degenerate 0..0 domain
  const usableHeight = CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;
  const yOf = (v: number) => CHART_PADDING_TOP + usableHeight - (v / maxValue) * usableHeight;

  const revenuePath = buildPath(revenueValues, months.length, yOf);
  const expensePath = buildPath(expenseValues, months.length, yOf);

  const revenueDiffMinor = snapshot.revenue.currentMinor - snapshot.revenue.previousMinor;
  const profitChange = snapshot.profit.change;

  return (
    <Card className="mt-6">
      <CardHeader title="מגמת העסק" description="הכנסות מול הוצאות בחודשים האחרונים — לפי חודש קלנדרי." />
      <div className="p-5">
        {months.length === 0 ? (
          <p className="text-sm text-zinc-500">עדיין אין מספיק נתונים להצגת מגמה.</p>
        ) : (
          <>
            <div className="mb-3 flex items-center gap-4 text-xs text-zinc-600">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-rose-500" /> הכנסות
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-zinc-400" /> הוצאות
              </span>
            </div>

            <svg
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              className="w-full touch-none"
              role="img"
              aria-label="גרף מגמת הכנסות והוצאות חודשיות"
              onMouseLeave={() => setActiveIndex(null)}
            >
              <path d={revenuePath} fill="none" stroke="#e11d48" strokeWidth={2.5} />
              <path d={expensePath} fill="none" stroke="#a1a1aa" strokeWidth={2.5} strokeDasharray="4 3" />

              {months.map((m, i) => {
                const x = xForIndex(i, months.length);
                const hitWidth = CHART_WIDTH / months.length;
                return (
                  <g key={m.monthKey}>
                    <circle cx={x} cy={yOf(m.revenueMinor)} r={4} fill="#e11d48" />
                    {m.totalExpensesMinor !== null && (
                      <circle cx={x} cy={yOf(m.totalExpensesMinor)} r={4} fill="#a1a1aa" />
                    )}
                    {/* Wide invisible hit target — easy to hover on desktop, easy to tap on mobile. */}
                    <rect
                      x={x - hitWidth / 2}
                      y={0}
                      width={hitWidth}
                      height={CHART_HEIGHT}
                      fill="transparent"
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => setActiveIndex((cur) => (cur === i ? null : i))}
                    />
                    <text
                      x={x}
                      y={CHART_HEIGHT - 8}
                      textAnchor="middle"
                      className={`text-[10px] ${m.isCurrentMonth ? "fill-rose-600 font-semibold" : "fill-zinc-400"}`}
                    >
                      {shortMonthLabel(m.monthKey)}
                      {m.isCurrentMonth ? " (נוכחי)" : ""}
                    </text>
                  </g>
                );
              })}

              {activeIndex !== null &&
                (() => {
                  const m = months[activeIndex];
                  const x = xForIndex(activeIndex, months.length);
                  const boxWidth = 130;
                  const boxHeight = m.totalExpensesMinor !== null ? 46 : 32;
                  const boxX = Math.min(Math.max(x - boxWidth / 2, 2), CHART_WIDTH - boxWidth - 2);
                  return (
                    <g pointerEvents="none">
                      <rect x={boxX} y={4} width={boxWidth} height={boxHeight} rx={6} fill="#18181b" opacity={0.92} />
                      <text x={boxX + boxWidth / 2} y={18} textAnchor="middle" className="fill-white text-[10px] font-semibold">
                        {shortMonthLabel(m.monthKey)}
                      </text>
                      <text x={boxX + boxWidth / 2} y={31} textAnchor="middle" className="fill-white text-[10px]">
                        הכנסות: {formatMoney(m.revenueMinor)}
                      </text>
                      {m.totalExpensesMinor !== null && (
                        <text x={boxX + boxWidth / 2} y={43} textAnchor="middle" className="fill-white text-[10px]">
                          הוצאות: {formatMoney(m.totalExpensesMinor)}
                        </text>
                      )}
                    </g>
                  );
                })()}
            </svg>
          </>
        )}

        <div className="mt-5 rounded-xl bg-zinc-50 p-4">
          <GrowthMessage change={snapshot.revenue.change} diffMinor={revenueDiffMinor} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
          <span>
            רווח החודש עד כה: <span className="font-semibold text-zinc-900">{formatMoney(snapshot.profit.currentMinor)}</span>
          </span>
          <span>
            שינוי לעומת התקופה המקבילה:{" "}
            <span className="font-semibold text-zinc-900">
              {profitChange === null
                ? "—"
                : `${profitChange.direction === "down" ? "-" : "+"}${Math.abs(profitChange.percent).toFixed(1)}%`}
            </span>
          </span>
        </div>
      </div>
    </Card>
  );
}
