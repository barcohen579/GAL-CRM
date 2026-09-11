"use client";

import { useState } from "react";
import { ArrowUp, ArrowDown, Minus } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { formatMoney } from "@/lib/crm/format";
import type { CurrentPeriodBusinessSnapshot, MonthOverMonthChange } from "@/lib/crm/marketing";

// "מגמת העסק" — a hand-rolled inline-SVG GROUPED BAR chart (revenue vs.
// expenses, one bar pair per real calendar month, up to the last 6) plus
// the revenue-growth indicator. Still no charting dependency: this
// codebase has zero UI/design-system dependencies anywhere, and a
// 2-series/<=6-month grouped bar chart doesn't warrant one — the v1 line
// chart (2 points connected by a line) read as thin specifically because
// a line communicates a TREND between many points, while what's actually
// being asked here — "how much did we make vs. spend THIS month" — is a
// per-month comparison bars express far more directly, especially with
// only 2 real months of history so far.
//
// All the actual numbers still come from lib/crm/marketing.ts —
// buildMonthlyMetrics (per-month totals, already the Dashboard's one
// authoritative revenue/expense calculation) and
// computeCurrentPeriodBusinessSnapshot (the current-partial-period-vs-
// same-range-last-month comparison) — this component only draws them,
// unchanged from the previous version.

export type TrendMonthPoint = {
  monthKey: string; // "YYYY-MM"
  isCurrentMonth: boolean;
  revenueMinor: number;
  /** null = Meta never synced this month (see MonthlyMetrics.totalExpensesMinor)
   *  — that month's expense bar is simply omitted rather than drawing a
   *  misleading 0. */
  totalExpensesMinor: number | null;
};

const CHART_WIDTH = 640;
const CHART_HEIGHT = 260;
const PADDING_LEFT = 46;
const PADDING_RIGHT = 8;
const PADDING_TOP = 26;
const PADDING_BOTTOM = 38;
const GRIDLINE_FRACTIONS = [0.25, 0.5, 0.75, 1];

const REVENUE_COLOR = "#e11d48"; // rose-600
const EXPENSE_COLOR = "#a1a1aa"; // zinc-400

const shortMonthFormatter = new Intl.DateTimeFormat("he-IL", { month: "short" });
function shortMonthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return shortMonthFormatter.format(new Date(y, m - 1, 1));
}

function formatSigned(diffMinor: number): string {
  if (diffMinor === 0) return formatMoney(0);
  return `${diffMinor > 0 ? "+" : "-"}${formatMoney(Math.abs(diffMinor))}`;
}

/** Compact ₪ for space-constrained spots (axis ticks, value labels above
 *  bars) — the exact figure is always still one tap/hover away in the
 *  tooltip via formatMoney. */
function formatCompactMoney(minor: number): string {
  const nis = minor / 100;
  if (Math.abs(nis) >= 10000) return `₪${(nis / 1000).toFixed(1)}k`;
  return formatMoney(minor);
}

/** Smallest "nice" ceiling (1/2/5 x 10^n) at or above `value` — standard
 *  chart-axis rounding so gridlines land on round numbers instead of
 *  whatever the real max happens to be. */
function niceCeil(value: number): number {
  if (value <= 0) return 100;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const fraction = value / magnitude;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * magnitude;
}

function GrowthMessage({ change, diffMinor }: { change: MonthOverMonthChange; diffMinor: number }) {
  if (change === null) {
    return (
      <div className="flex items-center gap-3 rounded-xl bg-zinc-50 p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-400">
          <Minus className="h-4 w-4" strokeWidth={2.5} />
        </span>
        <p className="text-sm font-medium text-zinc-600">
          אין הכנסות מהתקופה המקבילה בחודש הקודם להשוואה
        </p>
      </div>
    );
  }

  const isUp = change.direction === "up";
  const isDown = change.direction === "down";
  const palette = isUp
    ? { bg: "bg-emerald-50", chip: "bg-emerald-100 text-emerald-600", text: "text-emerald-700" }
    : isDown
      ? { bg: "bg-red-50", chip: "bg-red-100 text-red-600", text: "text-red-700" }
      : { bg: "bg-zinc-50", chip: "bg-zinc-100 text-zinc-500", text: "text-zinc-700" };
  const Icon = isUp ? ArrowUp : isDown ? ArrowDown : Minus;
  const verb = isUp ? "עלו" : isDown ? "ירדו" : null;

  return (
    <div className={`flex items-start gap-3 rounded-xl p-4 ${palette.bg}`}>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${palette.chip}`}>
        <Icon className="h-4 w-4" strokeWidth={2.5} />
      </span>
      <div>
        <p className={`text-sm font-semibold ${palette.text}`}>
          {verb
            ? `ההכנסות ${verb} ב-${Math.abs(change.percent).toFixed(1)}% לעומת אותה תקופה בחודש הקודם`
            : "ההכנסות ללא שינוי לעומת אותה תקופה בחודש הקודם"}
        </p>
        <p className={`mt-0.5 text-lg font-bold ${palette.text}`}>{formatSigned(diffMinor)}</p>
      </div>
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
  const roundedMax = niceCeil(Math.max(1, ...allValues));
  const usableWidth = CHART_WIDTH - PADDING_LEFT - PADDING_RIGHT;
  const usableHeight = CHART_HEIGHT - PADDING_TOP - PADDING_BOTTOM;
  const yOf = (v: number) => PADDING_TOP + usableHeight - (v / roundedMax) * usableHeight;

  const slotWidth = months.length > 0 ? usableWidth / months.length : usableWidth;
  const groupWidth = Math.min(slotWidth * 0.66, 88);
  const barWidth = groupWidth * 0.42;
  const barGap = groupWidth * 0.16;

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
                <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: REVENUE_COLOR }} /> הכנסות
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: EXPENSE_COLOR }} /> הוצאות
              </span>
            </div>

            <svg
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              className="w-full touch-none"
              role="img"
              aria-label="גרף עמודות מגמת הכנסות והוצאות חודשיות"
              onMouseLeave={() => setActiveIndex(null)}
            >
              {/* Gridlines + compact ₪ ticks */}
              {GRIDLINE_FRACTIONS.map((f) => {
                const value = roundedMax * f;
                const y = yOf(value);
                return (
                  <g key={f}>
                    <line
                      x1={PADDING_LEFT}
                      x2={CHART_WIDTH - PADDING_RIGHT}
                      y1={y}
                      y2={y}
                      stroke="#f4f4f5"
                      strokeWidth={1}
                    />
                    <text x={PADDING_LEFT - 6} y={y + 3} textAnchor="end" className="fill-zinc-400 text-[9px]">
                      {formatCompactMoney(value)}
                    </text>
                  </g>
                );
              })}
              {/* Baseline */}
              <line
                x1={PADDING_LEFT}
                x2={CHART_WIDTH - PADDING_RIGHT}
                y1={CHART_HEIGHT - PADDING_BOTTOM}
                y2={CHART_HEIGHT - PADDING_BOTTOM}
                stroke="#e4e4e7"
                strokeWidth={1}
              />

              {months.map((m, i) => {
                const groupCenterX = PADDING_LEFT + slotWidth * (i + 0.5);
                const revenueX = groupCenterX - barGap / 2 - barWidth;
                const expenseX = groupCenterX + barGap / 2;
                const revenueY = yOf(m.revenueMinor);
                const revenueH = CHART_HEIGHT - PADDING_BOTTOM - revenueY;
                const hasExpenses = m.totalExpensesMinor !== null;
                const expenseY = hasExpenses ? yOf(m.totalExpensesMinor as number) : CHART_HEIGHT - PADDING_BOTTOM;
                const expenseH = CHART_HEIGHT - PADDING_BOTTOM - expenseY;

                return (
                  <g key={m.monthKey}>
                    <rect
                      x={revenueX}
                      y={revenueY}
                      width={barWidth}
                      height={Math.max(revenueH, 1)}
                      rx={3}
                      fill={REVENUE_COLOR}
                    />
                    {m.revenueMinor > 0 && (
                      <text
                        x={revenueX + barWidth / 2}
                        y={revenueY - 5}
                        textAnchor="middle"
                        className="fill-zinc-600 text-[9px] font-medium"
                      >
                        {formatCompactMoney(m.revenueMinor)}
                      </text>
                    )}

                    {hasExpenses && (
                      <>
                        <rect
                          x={expenseX}
                          y={expenseY}
                          width={barWidth}
                          height={Math.max(expenseH, 1)}
                          rx={3}
                          fill={EXPENSE_COLOR}
                        />
                        {(m.totalExpensesMinor as number) > 0 && (
                          <text
                            x={expenseX + barWidth / 2}
                            y={expenseY - 5}
                            textAnchor="middle"
                            className="fill-zinc-400 text-[9px] font-medium"
                          >
                            {formatCompactMoney(m.totalExpensesMinor as number)}
                          </text>
                        )}
                      </>
                    )}

                    <text
                      x={groupCenterX}
                      y={CHART_HEIGHT - PADDING_BOTTOM + 16}
                      textAnchor="middle"
                      className={`text-[11px] ${m.isCurrentMonth ? "fill-zinc-700 font-semibold" : "fill-zinc-500"}`}
                    >
                      {shortMonthLabel(m.monthKey)}
                    </text>
                    {m.isCurrentMonth && (
                      <g>
                        <rect
                          x={groupCenterX - 15}
                          y={CHART_HEIGHT - PADDING_BOTTOM + 21}
                          width={30}
                          height={12}
                          rx={6}
                          fill="#fff1f2"
                        />
                        <text
                          x={groupCenterX}
                          y={CHART_HEIGHT - PADDING_BOTTOM + 29.5}
                          textAnchor="middle"
                          className="fill-rose-500 text-[8px] font-medium"
                        >
                          נוכחי
                        </text>
                      </g>
                    )}

                    {/* Wide invisible hit target — easy to hover on desktop, easy to tap on mobile. */}
                    <rect
                      x={PADDING_LEFT + slotWidth * i}
                      y={0}
                      width={slotWidth}
                      height={CHART_HEIGHT}
                      fill="transparent"
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => setActiveIndex((cur) => (cur === i ? null : i))}
                    />
                  </g>
                );
              })}

              {activeIndex !== null &&
                (() => {
                  const m = months[activeIndex];
                  const groupCenterX = PADDING_LEFT + slotWidth * (activeIndex + 0.5);
                  const boxWidth = 136;
                  const boxHeight = m.totalExpensesMinor !== null ? 48 : 34;
                  const boxX = Math.min(Math.max(groupCenterX - boxWidth / 2, 2), CHART_WIDTH - boxWidth - 2);
                  return (
                    <g pointerEvents="none">
                      <rect x={boxX} y={6} width={boxWidth} height={boxHeight} rx={8} fill="#18181b" opacity={0.94} />
                      <text x={boxX + boxWidth / 2} y={21} textAnchor="middle" className="fill-white text-[11px] font-semibold">
                        {shortMonthLabel(m.monthKey)}
                        {m.isCurrentMonth ? " · נוכחי" : ""}
                      </text>
                      <text x={boxX + boxWidth / 2} y={35} textAnchor="middle" className="fill-white text-[10px]">
                        הכנסות: {formatMoney(m.revenueMinor)}
                      </text>
                      {m.totalExpensesMinor !== null && (
                        <text x={boxX + boxWidth / 2} y={47} textAnchor="middle" className="fill-white text-[10px]">
                          הוצאות: {formatMoney(m.totalExpensesMinor)}
                        </text>
                      )}
                    </g>
                  );
                })()}
            </svg>
          </>
        )}

        <div className="mt-5">
          <GrowthMessage change={snapshot.revenue.change} diffMinor={revenueDiffMinor} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-100 pt-3 text-xs text-zinc-500">
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
