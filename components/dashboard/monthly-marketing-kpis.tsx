import { BadgeCheck, Target, TrendingUp, Trophy, Coins } from "lucide-react";
import { KpiCard, formatRatio } from "./business-report";
import { formatMoney } from "@/lib/crm/format";

// Meta marketing KPIs for the SELECTED month — sits alongside the
// existing range-based "ביצועי שיווק" section (see
// components/dashboard/marketing-performance.tsx, unchanged, still in
// its original position) rather than replacing it: that section
// answers "how is a flexible recent window performing", this answers
// "how did Meta perform in the exact calendar month I picked". Same
// attribution rules either way (lib/crm/marketing.ts), just a
// different time boundary.
export function MonthlyMarketingKpis({
  confirmedMetaLeadsCount,
  broadMetaLeadsCount,
  metaAttributedLeadsCount,
  primaryCplMinor,
  metaAttributedWonCount,
  confirmedMetaRevenueMinor,
  confirmedMetaRoas,
  confirmedMetaLeadsExistOverall,
}: {
  confirmedMetaLeadsCount: number;
  broadMetaLeadsCount: number;
  metaAttributedLeadsCount: number;
  primaryCplMinor: number | null;
  metaAttributedWonCount: number;
  confirmedMetaRevenueMinor: number;
  confirmedMetaRoas: number | null;
  confirmedMetaLeadsExistOverall: boolean;
}) {
  return (
    <div className="mb-6">
      <h3 className="mb-3 text-sm font-semibold text-zinc-900">שיווק — מטא (חודש נבחר)</h3>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
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
  );
}
