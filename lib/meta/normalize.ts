// Pure normalization helpers for Meta Lead Ads contact matching. No I/O,
// no Supabase/Meta calls — safe to unit test in isolation and safe to
// call on untrusted webhook input.
//
// Matching policy (see lib/meta/ingest.ts): normalized phone first,
// normalized email second, NEVER fuzzy name matching. These two
// functions are the entire "normalization" half of that policy — the
// actual matching/comparison happens in ingest.ts.

// Canonical digits-only form (E.164 digits, no leading '+'), with an
// Israel-specific "leading 0 -> 972" rule so '050-123-4567',
// '+972501234567' and '972501234567' all normalize identically. Never
// forces a country code onto a number that doesn't look Israeli —
// a valid non-Israeli international number is returned as its own
// stripped digit string rather than mangled.
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return null; // too short to plausibly be a real phone number

  // Israeli local format: leading 0 + 8 or 9 more digits
  // (e.g. 0501234567 — 05X mobile, or 0X-XXXXXXX landline).
  if (digits.startsWith("0") && digits.length >= 9 && digits.length <= 10) {
    return "972" + digits.slice(1);
  }

  // Israeli country code with an accidental extra leading 0 kept after
  // it (a common copy/paste mistake, e.g. 9720501234567) — strip the
  // stray 0 rather than store two different keys for the same number.
  if (digits.startsWith("9720") && digits.length === 13) {
    return "972" + digits.slice(4);
  }

  // Already E.164-shaped (with or without the leading '+', stripped
  // above) or a plausible non-Israeli international number — leave the
  // digits as-is.
  return digits;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}
