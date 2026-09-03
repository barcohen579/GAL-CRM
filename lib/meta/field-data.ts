// Extracts common fields from a Meta Lead Ads submission's field_data
// array. Pure, no I/O. IMPORTANT: field_data itself is the actual lead
// PII (name/phone/email/...) — nothing in this codebase may log the
// field_data array or any value pulled from it. Callers only ever pass
// the *extracted* values onward to Supabase writes, never to
// console.log/console.error.

export type MetaFieldDatum = { name: string; values: string[] };

export type ExtractedLeadFields = {
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
};

// Meta's built-in question types use these standard field keys. A
// custom question could use an arbitrary key, which is intentionally
// NOT guessed at here — better to leave a field null than to
// mis-extract an unrelated custom answer as someone's phone number.
const FULL_NAME_KEYS = ["full_name", "name"];
const FIRST_NAME_KEYS = ["first_name", "firstname"];
const LAST_NAME_KEYS = ["last_name", "lastname"];
const PHONE_KEYS = ["phone_number", "phone", "mobile", "mobile_number"];
const EMAIL_KEYS = ["email"];

function firstValue(fieldData: MetaFieldDatum[], keys: string[]): string | null {
  for (const field of fieldData) {
    const key = field?.name?.trim().toLowerCase();
    if (!key || !keys.includes(key)) continue;
    const value = field.values?.[0];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function extractLeadFields(
  fieldData: MetaFieldDatum[] | null | undefined
): ExtractedLeadFields {
  const fd = Array.isArray(fieldData) ? fieldData : [];

  const firstName = firstValue(fd, FIRST_NAME_KEYS);
  const lastName = firstValue(fd, LAST_NAME_KEYS);
  let fullName = firstValue(fd, FULL_NAME_KEYS);
  if (!fullName && (firstName || lastName)) {
    fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || null;
  }

  return {
    fullName,
    firstName,
    lastName,
    phone: firstValue(fd, PHONE_KEYS),
    email: firstValue(fd, EMAIL_KEYS),
  };
}
