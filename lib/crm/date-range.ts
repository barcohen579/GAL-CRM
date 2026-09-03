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

// ------------------------------------------------------------------
// Calendar-month helpers — for the monthly business-performance
// section. Real calendar months (not rolling windows), same local-Date
// convention as the rest of this file.
// ------------------------------------------------------------------

/** "YYYY-MM" — a sortable, locale-independent calendar-month key. */
export type MonthKey = string;

export function monthKeyOf(value: string | Date): MonthKey {
  const d = typeof value === "string" ? new Date(value) : value;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function currentMonthKey(): MonthKey {
  return monthKeyOf(new Date());
}

export function previousMonthKeyOf(key: MonthKey): MonthKey {
  const [y, m] = key.split("-").map(Number);
  const prev = toLocalDateOnly(y, m - 2, 1); // m is 1-based; -2 => previous month, 0-based
  return monthKeyOf(prev);
}

/** Hebrew month + year, e.g. "אוגוסט 2026". */
const monthLabelFormatter = new Intl.DateTimeFormat("he-IL", {
  month: "long",
  year: "numeric",
});

export function formatMonthLabel(key: MonthKey): string {
  const [y, m] = key.split("-").map(Number);
  return monthLabelFormatter.format(toLocalDateOnly(y, m - 1, 1));
}

/** [start, endExclusive) as ISO timestamps, for timestamptz columns. */
export function monthTimestampBounds(key: MonthKey): {
  startTimestamp: string;
  endTimestampExclusive: string;
} {
  const [y, m] = key.split("-").map(Number);
  const start = toLocalDateOnly(y, m - 1, 1);
  const endExclusive = toLocalDateOnly(y, m, 1);
  return { startTimestamp: start.toISOString(), endTimestampExclusive: endExclusive.toISOString() };
}

/** [startDate, endDate] as YYYY-MM-DD strings, inclusive — for `date` columns. */
export function monthDateBounds(key: MonthKey): { startDate: string; endDate: string } {
  const [y, m] = key.split("-").map(Number);
  const start = toLocalDateOnly(y, m - 1, 1);
  const end = toLocalDateOnly(y, m, 0); // day 0 of next month = last day of this month
  return { startDate: toDateString(start), endDate: toDateString(end) };
}

/** A valid "YYYY-MM" key, and nothing else — guards against a
 *  malformed ?month= query param (garbage, a full date, empty string)
 *  ever reaching a date computation. */
export function isValidMonthKey(value: unknown): value is MonthKey {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function nextMonthKeyOf(key: MonthKey): MonthKey {
  const [y, m] = key.split("-").map(Number);
  return monthKeyOf(toLocalDateOnly(y, m, 1)); // m is 1-based -> already next month, 0-based
}

export type SelectedMonth = {
  key: MonthKey;
  label: string;
  isCurrentMonth: boolean;
  /** The month a "next" control should navigate to — null when already
   *  at the current month (there is nothing useful to show for a
   *  future month with zero data by definition, so navigation is
   *  capped here rather than merely hidden after the fact). */
  nextMonthKey: MonthKey | null;
  previousMonthKey: MonthKey;
  startDate: string;
  endDate: string;
  startTimestamp: string;
  endTimestampExclusive: string;
};

/** Resolves the Monthly Business Report's selected month from a raw
 *  `?month=` query param. Invalid/missing/future input all fall back
 *  to the current month — this is a deliberate fail-safe default, not
 *  a silent data-hiding bug: a future month has no data to report by
 *  definition (see the task's own "do not allow navigating into
 *  meaningless future reporting periods" requirement), so there is no
 *  honest report to build for one regardless of what was requested. */
export function resolveSelectedMonth(rawMonth: string | undefined): SelectedMonth {
  const curKey = currentMonthKey();
  const key = isValidMonthKey(rawMonth) && rawMonth <= curKey ? rawMonth : curKey;

  const { startDate, endDate } = monthDateBounds(key);
  const { startTimestamp, endTimestampExclusive } = monthTimestampBounds(key);
  const isCurrentMonth = key === curKey;
  const candidateNext = nextMonthKeyOf(key);

  return {
    key,
    label: formatMonthLabel(key),
    isCurrentMonth,
    nextMonthKey: candidateNext <= curKey ? candidateNext : null,
    previousMonthKey: previousMonthKeyOf(key),
    startDate,
    endDate,
    startTimestamp,
    endTimestampExclusive,
  };
}
