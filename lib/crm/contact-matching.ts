// Deterministic contact matching for direct (non-lead) CRM entry
// flows — normalized phone first, normalized email second, NEVER by
// name. Reuses the exact normalization already built and tested for
// the Meta Lead Ads pipeline (lib/meta/normalize.ts) rather than
// duplicating it — that pipeline's own matching decision
// (lib/meta/ingest.ts::matchAndCreateCrmEntities) follows the same two
// rules inline; this module exists so a second call site (the "add
// customer" flow) can reuse the exact comparison logic instead of
// re-implementing it, and so that decision is independently unit-
// testable without a live database.

import { normalizeEmail, normalizePhone } from "../meta/normalize.ts";

export type ContactMatchCandidate = { id: string; phone: string | null; email: string | null };

export function findMatchingContactId(
  candidates: ContactMatchCandidate[],
  rawPhone: string | null,
  rawEmail: string | null
): string | null {
  const normalizedPhone = normalizePhone(rawPhone);
  if (normalizedPhone) {
    const match = candidates.find((c) => normalizePhone(c.phone) === normalizedPhone);
    if (match) return match.id;
  }

  const normalizedEmail = normalizeEmail(rawEmail);
  if (normalizedEmail) {
    const match = candidates.find((c) => normalizeEmail(c.email) === normalizedEmail);
    if (match) return match.id;
  }

  // Deliberately no name-based fallback — never fuzzy-match by name.
  return null;
}
