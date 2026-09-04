import {
  Wallet,
  UserPlus,
  Target,
  BadgeCheck,
  Trophy,
  Coins,
  TrendingUp,
} from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney } from "@/lib/crm/format";
import { KpiCard, formatRatio } from "./business-report";
import type { CampaignPeriodTotals } from "@/lib/crm/marketing";

// "שיווק — [חודש נבחר]" — the dashboard's ONE marketing section. Every
// figure here is scoped to the SAME selected month driving the rest of
// the dashboard (?month=YYYY-MM at the top) — there is no independent
// range control here (a previous version had its own 7d/30d/this-
// month/last-month selector; removed so the page has exactly one time
// context, not two). Same Meta-attribution rules as everywhere else in
// this app (lib/crm/marketing.ts): a lead counts as Meta-attributed
// only via a real META_AD touchpoint, CONFIRMED vs BROAD/UNKNOWN
// certainty is read back verbatim, never upgraded/inferred.
export type MarketingPerformanceData = {
  /** "אוגוסט 2026" — already formatted, drives the section title. */
  monthLabel: string;
  /** null = Meta sync never covered this month at all (unknown, NOT ₪0). */
  metaSpendMinor: number | null;
  metaAccountIds: string[];
  newLeadsCount: number;
  metaAttributedLeadsCount: number;
  confirmedMetaLeadsCount: number;
  broadMetaLeadsCount: number;
  primaryCplMinor: number | null;
  metaAttributedWonCount: number;
  revenueToSpendRatio: number | null;
  confirmedMetaLeadsExistOverall: boolean;
  confirmedMetaRevenueMinor: number;
  confirmedMetaRoas: number | null;
  campaigns: CampaignPeriodTotals[];
};

export function MarketingPerformance({ data }: { data: MarketingPerformanceData }) {
  const {
    monthLabel,
    metaSpendMinor,
    metaAccountIds,
    newLeadsCount,
    metaAttributedLeadsCount,
    confirmedMetaLeadsCount,
    broadMetaLeadsCount,
    primaryCplMinor,
    metaAttributedWonCount,
    revenueToSpendRatio,
    confirmedMetaLeadsExistOverall,
    confirmedMetaRevenueMinor,
    confirmedMetaRoas,
    campaigns,
  } = data;

  return (
    <div className="mt-8">
      <div className="mb-4">
        <h2 className="text-lg font-semibold tracking-tight text-zinc-900">
          שיווק — {monthLabel}
        </h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          הוצאת מטא, לידים והכנסות עבור החודש שנבחר למעלה — אותו חודש לכל הדוח.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          icon={Wallet}
          label="הוצאת פרסום במטא"
          value={metaSpendMinor === null ? null : formatMoney(metaSpendMinor)}
          unavailableText="אין נתוני סנכרון מטא לחודש זה"
          hint={
            metaAccountIds.length > 0
              ? `${metaAccountIds.length} חשבונות מטא מסונכרנים`
              : undefined
          }
        />
        <KpiCard icon={UserPlus} label="לידים חדשים" value={String(newLeadsCount)} />
        <KpiCard
          icon={Target}
          label="לידים משויכים למטא"
          value={String(metaAttributedLeadsCount)}
          hint={`כולל ${broadMetaLeadsCount} לא ודאיים (BROAD)`}
        />
        <KpiCard
          icon={BadgeCheck}
          label="לידים מאומתים ממטא"
          value={String(confirmedMetaLeadsCount)}
          hint="ייחוס ודאי (CONFIRMED)"
        />
      </div>

      {/* Derived, guard-sensitive numbers (CPL/WON/revenue/ROAS) —
          separated from the raw counts above with their own honesty
          caveats about when they're not yet reliably measurable. */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          icon={TrendingUp}
          label="עלות לליד מאומת (CPL)"
          value={primaryCplMinor === null ? null : formatMoney(primaryCplMinor)}
          unavailableText="אין עדיין לידים מאומתים ממטא החודש"
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
          unavailableText="עדיין לא ניתן למדידה אמינה — אין לידים עם ייחוס מאומת ממטא"
          hint={
            confirmedMetaLeadsExistOverall
              ? 'לא לבלבל עם יחס הכנסות כלליות מול הוצאת מטא (למטה) — זהו ROAS על הכנסה מאומתת בלבד'
              : undefined
          }
        />
      </div>

      {/* Overall business revenue / Meta spend — deliberately never
          labeled "ROAS" (not all revenue is provably Meta-attributed;
          the real ROAS card above is the only one allowed that name). */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          icon={TrendingUp}
          label="יחס הכנסות כלליות מול הוצאת מטא"
          value={revenueToSpendRatio === null ? null : formatRatio(revenueToSpendRatio)}
          unavailableText="אין הוצאת מטא בחודש זה"
          hint='יחס בין כלל הכנסות העסק להוצאת מטא — לא "ROAS" של מטא, כי לא כל ההכנסה בהכרח הגיעה ממטא.'
        />
      </div>

      <Card className="mt-6">
        <CardHeader
          title="ביצועי קמפיינים"
          description={
            campaigns.length > 0
              ? "טווח ההגעה (Reach) מוצג כסכום יומי מוערך — לא כמספר ייחודי מדויק."
              : undefined
          }
        />
        {campaigns.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={Target}
              title="אין נתוני קמפיינים לחודש הזה"
              description="קמפיינים עם הוצאה בחודש שנבחר יופיעו כאן."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-zinc-100 text-xs text-zinc-500">
                  <th className="px-5 py-2.5 text-start font-medium">קמפיין</th>
                  <th className="px-5 py-2.5 text-start font-medium">חשבון מטא</th>
                  <th className="px-5 py-2.5 text-end font-medium">הוצאה</th>
                  <th className="px-5 py-2.5 text-end font-medium">חשיפות</th>
                  <th className="px-5 py-2.5 text-end font-medium">הגעה (≈)</th>
                  <th className="px-5 py-2.5 text-end font-medium">קליקים</th>
                  <th className="px-5 py-2.5 text-end font-medium">CPC</th>
                  <th className="px-5 py-2.5 text-end font-medium">CPM</th>
                  <th className="px-5 py-2.5 text-end font-medium">CTR</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {campaigns.map((c) => (
                  <tr key={`${c.meta_ad_account_id}-${c.campaign_id}`}>
                    <td className="max-w-[220px] truncate px-5 py-3 font-medium text-zinc-900">
                      {c.campaign_name ?? c.campaign_id}
                    </td>
                    <td className="px-5 py-3 text-xs text-zinc-500" dir="ltr">
                      {c.meta_ad_account_id}
                    </td>
                    <td className="px-5 py-3 text-end">{formatMoney(c.spend_minor)}</td>
                    <td className="px-5 py-3 text-end">
                      {c.impressions.toLocaleString("he-IL")}
                    </td>
                    <td className="px-5 py-3 text-end text-zinc-500">
                      ≈{c.approxReachSum.toLocaleString("he-IL")}
                    </td>
                    <td className="px-5 py-3 text-end">
                      {c.clicks.toLocaleString("he-IL")}
                    </td>
                    <td className="px-5 py-3 text-end">
                      {c.cpcMinor === null ? "—" : formatMoney(c.cpcMinor)}
                    </td>
                    <td className="px-5 py-3 text-end">
                      {c.cpmMinor === null ? "—" : formatMoney(c.cpmMinor)}
                    </td>
                    <td className="px-5 py-3 text-end">
                      {c.ctrPercent === null ? "—" : `${c.ctrPercent.toFixed(2)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
