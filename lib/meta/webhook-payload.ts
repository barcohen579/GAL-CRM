// Parses a (signature-verified) Meta webhook body into leadgen change
// entries. Pure, no I/O. IMPORTANT: this is the shape of the WEBHOOK
// NOTIFICATION only — it never contains field_data / lead answers, only
// ids and a timestamp (Meta requires a separate authenticated Graph API
// call for the actual submission — see lib/meta/graph.ts). Handles
// multiple entries/changes in a single delivery, and ignores any
// unrelated object type or change field safely (never throws on
// unexpected shape).

export type LeadgenWebhookEntry = {
  leadgenId: string;
  pageId: string;
  formId: string | null;
  adId: string | null;
  /** Meta's own field name for this is "adgroup_id". */
  adsetId: string | null;
  campaignId: string | null;
  createdTimeIso: string | null;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseLeadgenWebhookEntries(body: unknown): LeadgenWebhookEntry[] {
  const results: LeadgenWebhookEntry[] = [];

  if (!body || typeof body !== "object") return results;
  const root = body as Record<string, unknown>;

  // Meta sends other object types (e.g. "instagram") to the same app —
  // ignore anything that isn't a Page webhook rather than erroring.
  if (root.object !== "page") return results;

  const entries = Array.isArray(root.entry) ? root.entry : [];
  for (const entryRaw of entries) {
    if (!entryRaw || typeof entryRaw !== "object") continue;
    const entry = entryRaw as Record<string, unknown>;
    const entryPageId = asString(entry.id);

    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const changeRaw of changes) {
      if (!changeRaw || typeof changeRaw !== "object") continue;
      const change = changeRaw as Record<string, unknown>;

      // Ignore any subscribed field other than leadgen safely (e.g. a
      // Page could have other fields subscribed for other purposes).
      if (change.field !== "leadgen") continue;

      const value = change.value;
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;

      const leadgenId = asString(v.leadgen_id);
      if (!leadgenId) continue; // unusable without the idempotency key

      const pageId = asString(v.page_id) ?? entryPageId;
      if (!pageId) continue; // required downstream to derive a Page Access Token

      const createdTimeRaw = v.created_time;
      const createdTimeIso =
        typeof createdTimeRaw === "number"
          ? new Date(createdTimeRaw * 1000).toISOString()
          : null;

      results.push({
        leadgenId,
        pageId,
        formId: asString(v.form_id),
        adId: asString(v.ad_id),
        adsetId: asString(v.adgroup_id),
        campaignId: asString(v.campaign_id),
        createdTimeIso,
      });
    }
  }

  return results;
}
