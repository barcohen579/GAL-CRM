// Pure date helpers for the recurring-billing feature. No Supabase
// calls here — plain string/number arithmetic on "YYYY-MM-DD" date
// strings, deliberately never a JS Date object: purchases.next_billing_date
// and payments.billing_cycle are plain SQL `date` columns (no time, no
// timezone), and going through Date/toISOString invites exactly the
// off-by-one-day timezone bugs this feature cannot afford. See
// supabase/migrations/20260903150000_..._recurring_billing_schema.sql
// for why a cycle is always identified by its calendar month alone
// (first-of-month), never an exact day-of-month anchor.

/** Normalizes any "YYYY-MM-DD" (or longer ISO) date string to the
 *  first day of its own calendar month, e.g. "2026-09-17" -> "2026-09-01". */
export function firstOfMonth(dateIso: string): string {
  return `${dateIso.slice(0, 7)}-01`;
}

/** Adds a whole number of calendar months to a "YYYY-MM-DD" date,
 *  always returning the first of the resulting month (this feature
 *  never needs anything but first-of-month results — see firstOfMonth
 *  above). Negative `months` moves backward. Handles year rollover in
 *  both directions (e.g. December + 1 -> January of the next year). */
export function addCalendarMonths(dateIso: string, months: number): string {
  const [year, month] = dateIso.slice(0, 7).split("-").map(Number);
  const totalMonths = year * 12 + (month - 1) + months;
  const newYear = Math.floor(totalMonths / 12);
  const newMonth = ((totalMonths % 12) + 12) % 12; // 0-11, safe for negative totalMonths
  return `${newYear}-${String(newMonth + 1).padStart(2, "0")}-01`;
}
