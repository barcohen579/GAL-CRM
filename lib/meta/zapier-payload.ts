// Parses and validates a POST body from the Zapier "Webhooks by Zapier"
// action (fed by Zapier's own "Facebook Lead Ads -> New Lead" trigger).
// Pure, no I/O — safe to unit test in isolation and safe to call on
// untrusted input (this runs AFTER auth but BEFORE anything touches
// Supabase). IMPORTANT: fullName/phone/email are lead PII — nothing in
// this codebase may log them (mirrors lib/meta/field-data.ts's own
// warning for the direct Meta webhook pipeline).
//
// Unlike the direct Meta webhook (app/api/meta/leadgen-webhook), Zapier
// has already resolved the lead's full field data via its own Facebook
// Lead Ads trigger — there is no separate Graph API fetch step here,
// and no field_data array to extract from. The caller supplies already-
// named values directly as flat JSON keys.

export type ZapierLeadInput = {
  facebookLeadId: string;
  fullName: string;
  phone: string;
  email: string | null;
  source: string | null;
  campaignName: string | null;
  formName: string | null;
  adId: string | null;
  adName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  /** Optional bonus fields Zapier's raw trigger data also exposes — not
   *  required in the Zapier field mapping, but used when present. */
  pageId: string | null;
  formId: string | null;
  /** ISO datetime string, if Zapier's "Created At" field is mapped. */
  occurredAt: string | null;
};

export type ParseZapierLeadResult =
  | { ok: true; value: ZapierLeadInput }
  | { ok: false; errors: string[] };

// Accepts a non-empty string as-is (trimmed); accepts a finite number
// by stringifying it (Facebook's numeric ids sometimes arrive as
// numbers rather than strings depending on how a Zap step formats
// them); rejects everything else (objects, arrays, booleans, empty
// strings) as null/invalid.
function asOptionalString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function asOptionalIsoDate(value: unknown): string | null {
  const str = asOptionalString(value);
  if (!str) return null;
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function parseZapierLeadPayload(body: unknown): ParseZapierLeadResult {
  const errors: string[] = [];

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      errors: [
        "Request body must be a single JSON object (not an array) — in the Zapier " +
          'POST action, set "Wrap Request In Array" to No.',
      ],
    };
  }

  const b = body as Record<string, unknown>;

  const facebookLeadId = asOptionalString(b.facebookLeadId);
  if (!facebookLeadId) errors.push("facebookLeadId is required and must be a non-empty string.");

  const fullName = asOptionalString(b.fullName);
  if (!fullName) errors.push("fullName is required and must be a non-empty string.");

  const phone = asOptionalString(b.phone);
  if (!phone) errors.push("phone is required and must be a non-empty string.");

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      facebookLeadId: facebookLeadId!,
      fullName: fullName!,
      phone: phone!,
      email: asOptionalString(b.email),
      source: asOptionalString(b.source),
      campaignName: asOptionalString(b.campaignName),
      formName: asOptionalString(b.formName),
      adId: asOptionalString(b.adId),
      adName: asOptionalString(b.adName),
      adsetId: asOptionalString(b.adsetId),
      adsetName: asOptionalString(b.adsetName),
      campaignId: asOptionalString(b.campaignId),
      pageId: asOptionalString(b.pageId),
      formId: asOptionalString(b.formId),
      occurredAt: asOptionalIsoDate(b.occurredAt),
    },
  };
}
