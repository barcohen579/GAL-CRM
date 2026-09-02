// Date-range resolution for the dashboard's marketing section.
//
// Follows the same local-Date convention already used throughout this
// app (see startOfMonthISO/startOfTodayISO/endOfTodayISO in format.ts)
// rather than introducing per-account IANA timezone precision here —
// that precision belongs to scripts/meta-sync.mjs, which must reconcile
// two *different* ad-account timezones against Meta itself. The CRM's
// own business dates (leads, payments, ...) have never distinguished
// server-local time from Asia/Jerusalem anywhere else in this app, and
// this section intentionally stays consistent with that rather than
// being the one inconsistent place that suddenly cares.

export const MARKETING_RANGE_OPTIONS = [
  { value: "7d", label: "7 ימים אחרונים" },
  { value: "30d", label: "30 ימים אחרונים" },
  { value: "month", label: "החודש הנוכחי" },
  { value: "prev_month", label: "החודש הקודם" },
] as const;

export type MarketingRangeKey = (typeof MARKETING_RANGE_OPTIONS)[number]["value"];

export const DEFAULT_MARKETING_RANGE: MarketingRangeKey = "30d";

export function isMarketingRangeKey(value: unknown): value is MarketingRangeKey {
  return MARKETING_RANGE_OPTIONS.some((o) => o.value === value);
}

export type ResolvedMarketingRange = {
  key: MarketingRangeKey;
  label: string;
  /** Plain YYYY-MM-DD, inclusive — for `date` columns (payments.paid_at, metric_date). */
  sinceDate: string;
  /** Plain YYYY-MM-DD, inclusive — for `date` columns. */
  untilDate: string;
  /** ISO timestamp, inclusive lower bound — for `timestamptz` columns. */
  sinceTimestamp: string;
  /** ISO timestamp, EXCLUSIVE upper bound (start of the day after untilDate) — for `timestamptz` columns. */
  untilTimestampExclusive: string;
};

function toLocalDateOnly(y: number, m: number, d: number): Date {
  return new Date(y, m, d);
}

function toDateString(d: Date): string {
  // Local Y/M/D, zero-padded — NOT toISOString() (which would shift to
  // UTC and could land on a different calendar day).
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function resolveMarketingRange(rawKey: string | undefined): ResolvedMarketingRange {
  const key: MarketingRangeKey = isMarketingRangeKey(rawKey) ? rawKey : DEFAULT_MARKETING_RANGE;
  const label = MARKETING_RANGE_OPTIONS.find((o) => o.value === key)!.label;

  const now = new Date();
  const today = toLocalDateOnly(now.getFullYear(), now.getMonth(), now.getDate());

  let sinceDay: Date;
  let untilDay: Date;

  switch (key) {
    case "7d":
      untilDay = today;
      sinceDay = toLocalDateOnly(today.getFullYear(), today.getMonth(), today.getDate() - 6);
      break;
    case "30d":
      untilDay = today;
      sinceDay = toLocalDateOnly(today.getFullYear(), today.getMonth(), today.getDate() - 29);
      break;
    case "month":
      sinceDay = toLocalDateOnly(today.getFullYear(), today.getMonth(), 1);
      untilDay = today;
      break;
    case "prev_month":
      sinceDay = toLocalDateOnly(today.getFullYear(), today.getMonth() - 1, 1);
      untilDay = toLocalDateOnly(today.getFullYear(), today.getMonth(), 0); // day 0 = last day of previous month
      break;
  }

  const untilExclusiveDay = toLocalDateOnly(
    untilDay.getFullYear(),
    untilDay.getMonth(),
    untilDay.getDate() + 1
  );

  return {
    key,
    label,
    sinceDate: toDateString(sinceDay),
    untilDate: toDateString(untilDay),
    sinceTimestamp: sinceDay.toISOString(),
    untilTimestampExclusive: untilExclusiveDay.toISOString(),
  };
}
