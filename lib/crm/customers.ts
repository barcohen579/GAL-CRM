// Pure helpers for the /customers page. Kept separate from page.tsx (a
// Server Component, not unit-testable under node --test — same
// constraint documented for other pages in this repo) so the actual
// counting rule has a real, fast, regression-proof test.

/** The total number of real Customers — literally the row count of
 *  `customers` (see /customers/page.tsx's own query, which fetches the
 *  ENTIRE table with no filter/limit, so `rows.length` already IS the
 *  exact total). Deliberately takes just `{id}` rows: this must never
 *  be confused with counting Leads, Purchases, or Payments — it only
 *  ever counts what's actually in `rows`. */
export function countCustomers(rows: { id: string }[]): number {
  return rows.length;
}
