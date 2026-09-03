// Pure calculation helper for the referrer's "הפניות" section on
// /customers/[id]. No Supabase calls here — the page fetches the
// referrals-made rows and the referred customers' purchases/payments
// separately (see app/(app)/customers/[id]/page.tsx), and this module
// only derives the three V1 numbers from already-fetched rows.
//
// SCOPE / NON-GOALS (V1, explicitly requested to stay lightweight):
// - Non-recursive: only revenue from people THIS customer directly
//   referred, never a referred customer's own referrals. Nothing here
//   walks the referral graph beyond one hop.
// - Not LTV: this is money paid so far (status = 'PAID'), not a
//   lifetime-value projection.

export type ReferralMadeRow = {
  referred_contact: {
    customers: { id: string } | null;
  } | null;
};

export type ReferredPurchaseRow = {
  payments: { amount: number; status: string }[];
};

export type ReferralMetrics = {
  /** Every contact this customer referred, whether or not they ever
   *  became a Lead or a Customer. */
  referredCount: number;
  /** Of those, how many currently have a Customer row (deduplicated —
   *  a contact has at most one Customer, but this guards the shape
   *  regardless). */
  becameCustomerCount: number;
  /** Sum of PAID payments across every purchase belonging to a
   *  referred customer. Callers must pre-scope `referredPurchases` to
   *  exactly those customers (see the page's query) — this function
   *  does not re-derive that scoping itself. */
  revenueMinor: number;
};

export function computeReferralMetrics(
  referralsMade: ReferralMadeRow[],
  referredPurchases: ReferredPurchaseRow[]
): ReferralMetrics {
  const referredCustomerIds = new Set(
    referralsMade
      .map((r) => r.referred_contact?.customers?.id)
      .filter((id): id is string => Boolean(id))
  );

  const revenueMinor = referredPurchases
    .flatMap((p) => p.payments)
    .filter((pay) => pay.status === "PAID")
    .reduce((sum, pay) => sum + pay.amount, 0);

  return {
    referredCount: referralsMade.length,
    becameCustomerCount: referredCustomerIds.size,
    revenueMinor,
  };
}
