import Link from "next/link";
import {
  Wallet,
  UserPlus,
  Target,
  BadgeCheck,
  HelpCircle,
  Coins,
  Trophy,
  TrendingUp,
} from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney, formatDate } from "@/lib/crm/format";
import {
  MARKETING_RANGE_OPTIONS,
  type ResolvedMarketingRange,
} from "@/lib/crm/date-range";
import type { CampaignPeriodTotals } from "@/lib/crm/marketing";

type MarketingStat = {
  label: string;
  value: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
};

export type MarketingPerformanceData = {
  range: ResolvedMarketingRange;
  metaSpendMinor: number;
  metaAccountIds: string[];
  newLeadsCount: number;
  metaAttributedLeadsCount: number;
  confirmedMetaLeadsCount: number;
  broadMetaLeadsCount: number;
  primaryCplMinor: number | null;
  secondaryCplMinor: number | null;
  wonCount: number;
  revenueMinor: number;
  revenueToSpendRatio: number | null;
  confirmedMetaLeadsExistOverall: boolean;
  confirmedMetaRevenueMinor: number;
  confirmedMetaRoas: number | null;
  campaigns: CampaignPeriodTotals[];
};

function formatRatio(ratio: number | null): string {
  if (ratio === null) return "—";
  return `×${ratio.toFixed(2)}`;
}

export function MarketingPerformance({ data }: { data: MarketingPerformanceData }) {
  const {
    range,
    metaSpendMinor,
    metaAccountIds,
    newLeadsCount,
    metaAttributedLeadsCount,
    confirmedMetaLeadsCount,
    broadMetaLeadsCount,
    primaryCplMinor,
    secondaryCplMinor,
    wonCount,
    revenueMinor,
    revenueToSpendRatio,
    confirmedMetaLeadsExistOverall,
    confirmedMetaRevenueMinor,
    confirmedMetaRoas,
    campaigns,
  } = data;

  const stats: MarketingStat[] = [
    {
      label: "הוצאת פרסום במטא",
      value: formatMoney(metaSpendMinor),
      hint: `${metaAccountIds.length} חשבונות מטא מסונכרנים`,
      icon: Wallet,
    },
    { label: "לידים חדשים", value: String(newLeadsCount), icon: UserPlus },
    {
      label: "לידים משויכים למטא",
      value: String(metaAttributedLeadsCount),
      hint: "לפחות נקודת מגע אחת מפרסומת במטא",
      icon: Target,
    },
    {
      label: "לידים מאומתים ממטא",
      value: String(confirmedMetaLeadsCount),
      hint: "ייחוס ודאי (CONFIRMED)",
      icon: BadgeCheck,
    },
    {
      label: "לידים לא ודאיים ממטא",
      value: String(broadMetaLeadsCount),
      hint: "ייחוס רחב / לא ודאי",
      icon: HelpCircle,
    },
    {
      label: "נסגרו (WON)",
      value: String(wonCount),
      hint: "מעבר לשלב נסגרה בטווח שנבחר",
      icon: Trophy,
    },
    {
      label: "הכנסות בפועל",
      value: formatMoney(revenueMinor),
      hint: "תשלומים ששולמו בפועל בלבד",
      icon: Coins,
    },
  ];

  return (
    <div className="mt-8">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-zinc-900">
            ביצועי שיווק
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            הוצאה, לידים והכנסות עבור {range.label} · {formatDate(range.sinceDate)} –{" "}
            {formatDate(range.untilDate)}
          </p>
        </div>
        <RangeSwitcher activeKey={range.key} />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                {s.label}
              </p>
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500">
                <s.icon className="h-4 w-4" strokeWidth={2} />
              </div>
            </div>
            <p className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900">
              {s.value}
            </p>
            {s.hint && <p className="mt-1 text-xs text-zinc-500">{s.hint}</p>}
          </div>
        ))}
      </div>

      {/* CPL + revenue ratios — separated from the raw counts above since
          these are derived, guard-sensitive numbers with their own
          honesty caveats. */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <RatioCard
          icon={TrendingUp}
          label="עלות לליד מאומת (CPL)"
          value={primaryCplMinor === null ? null : formatMoney(primaryCplMinor)}
          unavailableText="אין עדיין לידים מאומתים ממטא בטווח הזה"
        />
        <RatioCard
          icon={TrendingUp}
          label="עלות לליד (רחב, פחות ודאי)"
          value={secondaryCplMinor === null ? null : formatMoney(secondaryCplMinor)}
          unavailableText="אין עדיין לידים משויכים למטא בטווח הזה"
          muted
        />
        <RatioCard
          icon={TrendingUp}
          label="יחס הכנסות כלליות מול הוצאת מטא"
          value={revenueToSpendRatio === null ? null : formatRatio(revenueToSpendRatio)}
          unavailableText="אין הוצאת מטא בטווח הזה"
          note='זהו יחס בין כלל הכנסות העסק להוצאת מטא — לא "ROAS" של מטא, כי לא כל ההכנסה בהכרח הגיעה ממטא.'
        />
        <RatioCard
          icon={TrendingUp}
          label="ROAS מאומת ממטא"
          value={
            confirmedMetaLeadsExistOverall
              ? formatRatio(confirmedMetaRoas)
              : null
          }
          unavailableText="עדיין לא ניתן למדוד באופן אמין — אין לידים עם ייחוס מאומת ממטא"
          note={
            confirmedMetaLeadsExistOverall
              ? `הכנסה מאומתת ממטא בטווח: ${formatMoney(confirmedMetaRevenueMinor)}`
              : undefined
          }
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
              title="אין נתוני קמפיינים לטווח הזה"
              description="קמפיינים עם הוצאה בטווח שנבחר יופיעו כאן."
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

function RangeSwitcher({ activeKey }: { activeKey: string }) {
  return (
    <div className="inline-flex flex-wrap items-center gap-1 rounded-xl border border-zinc-200 bg-white p-1">
      {MARKETING_RANGE_OPTIONS.map((opt) => (
        <Link
          key={opt.value}
          href={`/dashboard?range=${opt.value}#marketing`}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            opt.value === activeKey
              ? "bg-rose-600 text-white"
              : "text-zinc-600 hover:bg-zinc-50"
          }`}
        >
          {opt.label}
        </Link>
      ))}
    </div>
  );
}

function RatioCard({
  icon: Icon,
  label,
  value,
  unavailableText,
  note,
  muted,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  value: string | null;
  unavailableText: string;
  note?: string;
  muted?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-5 shadow-sm ${
        muted ? "border-dashed border-zinc-200 bg-zinc-50/60" : "border-zinc-200 bg-white"
      }`}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          {label}
        </p>
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500">
          <Icon className="h-4 w-4" strokeWidth={2} />
        </div>
      </div>
      {value === null ? (
        <p className="mt-3 text-sm text-zinc-400">{unavailableText}</p>
      ) : (
        <p className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900">
          {value}
        </p>
      )}
      {note && <p className="mt-1 text-xs text-zinc-500">{note}</p>}
    </div>
  );
}
