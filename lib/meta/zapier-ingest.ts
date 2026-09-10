// Zapier -> GAL CRM Facebook Lead Ads ingestion orchestration.
//
// This is a SECOND top-level entry point into the same Meta Lead Ads
// ingestion pipeline as app/api/meta/leadgen-webhook — it deliberately
// reuses matchAndCreateCrmEntities (lib/meta/ingest.ts), the shared
// MetaIngestionRepo (lib/meta/repo.ts, backed by meta_lead_ingestions /
// contacts / leads / touchpoints), and the same phone/email
// normalization (lib/meta/normalize.ts). Nothing about "how a Facebook
// Lead Ads submission becomes a Contact/Lead/Touchpoint" is duplicated
// here — only the SOURCE of the lead fields differs:
//
//   Direct Meta webhook: receives only ids (leadgen_id, page_id, ...),
//     then calls the Graph API to fetch field_data (name/phone/email).
//   Zapier: Zapier's own "Facebook Lead Ads -> New Lead" trigger has
//     ALREADY resolved the full lead (Zapier calls the Graph API on
//     our behalf), so this path receives fullName/phone/email/etc.
//     directly in the POST body — no second Graph API call needed, and
//     no Page Access Token derivation needed.
//
// Because both paths share the same meta_lead_ingestions table keyed on
// leadgen_id (here: facebookLeadId — the same real Facebook lead id in
// both cases) and the same touchpoints partial-unique-index on
// (external_ref, channel='META_AD'), the SAME real Facebook lead can
// never be double-processed even if it somehow arrived via both routes
// (e.g. the direct webhook gets connected later) — whichever request
// wins the claim processes it; the other is reported as a duplicate.
import { FALLBACK_FULL_NAME, matchAndCreateCrmEntities, sanitizeErrorMessage } from "./ingest.ts";
import type { ProcessOutcome } from "./ingest.ts";
import type { MetaIngestionRepo } from "./repo.ts";
import type { ZapierLeadInput } from "./zapier-payload.ts";

// meta_lead_ingestions.meta_page_id is NOT NULL (see the Phase 3B
// migration) because the direct Meta webhook always has a real page id
// at the point of insert. Zapier's Facebook Lead Ads trigger typically
// exposes a page id too, but it isn't one of the fields this endpoint
// requires (see docs/zapier-facebook-leads.md) — this fallback keeps
// the shared table's constraint satisfied on the rare submission where
// it wasn't mapped, without making it a hard requirement for Zapier
// setup.
const ZAPIER_FALLBACK_PAGE_ID = "zapier";

function buildSourceDetail(input: ZapierLeadInput): string {
  const parts = ["ליד מפרסומת Meta (Lead Ads) — התקבל דרך Zapier"];
  if (input.campaignName) parts.push(`קמפיין: ${input.campaignName}`);
  if (input.formName) parts.push(`טופס: ${input.formName}`);
  return parts.join(" | ");
}

// Only includes keys Zapier actually supplied — mirrors
// lib/meta/ingest.ts's buildTouchpointMetadata for the direct webhook
// path. campaignName/formName/adName/adsetName are NOT lead PII (they
// describe the ad/campaign, not the person), so — unlike
// fullName/phone/email — they are safe to persist here.
function buildMetadata(input: ZapierLeadInput): Record<string, unknown> | null {
  const meta: Record<string, unknown> = { via: "zapier" };
  if (input.pageId) meta.pageId = input.pageId;
  if (input.formId) meta.formId = input.formId;
  if (input.formName) meta.formName = input.formName;
  if (input.adId) meta.adId = input.adId;
  if (input.adName) meta.adName = input.adName;
  if (input.adsetId) meta.adsetId = input.adsetId;
  if (input.adsetName) meta.adsetName = input.adsetName;
  if (input.campaignId) meta.campaignId = input.campaignId;
  if (input.campaignName) meta.campaignName = input.campaignName;
  if (input.source) meta.zapierSource = input.source;
  return meta;
}

// Processes exactly one Zapier-relayed Facebook lead submission end to
// end, mirroring processOneLeadgenId's (lib/meta/ingest.ts) state
// machine but without the Graph API fetch step:
//   1. Find (or create) the meta_lead_ingestions row for this
//      facebookLeadId (reused as the leadgen_id idempotency key).
//   2. If already terminal-successful, return "duplicate" untouched.
//   3. Atomically claim it for processing.
//   4. Match/create the Contact -> Lead -> Touchpoint directly from the
//      already-resolved input fields, and mark the row PROCESSED (or
//      DUPLICATE_IGNORED if the entity-level guard itself caught it).
//   5. On any failure, mark FAILED with a sanitized message, retryable.
export async function processZapierLead(
  repo: MetaIngestionRepo,
  input: ZapierLeadInput,
  receivedAt: string
): Promise<ProcessOutcome> {
  let row = await repo.getIngestionRowByLeadgenId(input.facebookLeadId);

  if (!row) {
    row = await repo.insertIngestionRow(input.facebookLeadId, {
      metaPageId: input.pageId ?? ZAPIER_FALLBACK_PAGE_ID,
      metaFormId: input.formId,
      metaAdId: input.adId,
      metaAdsetId: input.adsetId,
      metaCampaignId: input.campaignId,
      receivedAt,
      // Ids/names only — never fullName/phone/email. See file-level
      // PII warning and the migration's own raw_payload comment.
      rawPayload: {
        via: "zapier",
        facebookLeadId: input.facebookLeadId,
        pageId: input.pageId,
        formId: input.formId,
        formName: input.formName,
        adId: input.adId,
        adName: input.adName,
        adsetId: input.adsetId,
        adsetName: input.adsetName,
        campaignId: input.campaignId,
        campaignName: input.campaignName,
        source: input.source,
      },
    });
  }

  if (row.status === "PROCESSED" || row.status === "DUPLICATE_IGNORED") {
    return {
      outcome: "duplicate",
      ingestionId: row.id,
      contactId: row.contact_id,
      leadId: row.lead_id,
      touchpointId: row.touchpoint_id,
    };
  }

  const claimed = await repo.claimForProcessing(row.id);
  if (!claimed) {
    const latest = await repo.getIngestionRowById(row.id);
    if (latest && (latest.status === "PROCESSED" || latest.status === "DUPLICATE_IGNORED")) {
      return {
        outcome: "duplicate",
        ingestionId: row.id,
        contactId: latest.contact_id,
        leadId: latest.lead_id,
        touchpointId: latest.touchpoint_id,
      };
    }
    return { outcome: "in_progress_elsewhere", ingestionId: row.id };
  }

  try {
    const result = await matchAndCreateCrmEntities(repo, {
      fullName: input.fullName || FALLBACK_FULL_NAME,
      phone: input.phone,
      email: input.email,
      leadgenId: input.facebookLeadId,
      occurredAt: input.occurredAt ?? claimed.received_at,
      sourceDetail: buildSourceDetail(input),
      metadata: buildMetadata(input),
    });

    if (result.wasDuplicate) {
      await repo.markDuplicate(claimed.id, result);
      return {
        outcome: "duplicate",
        ingestionId: claimed.id,
        contactId: result.contactId,
        leadId: result.leadId,
        touchpointId: result.touchpointId,
      };
    }

    await repo.markProcessed(claimed.id, result);
    return {
      outcome: "processed",
      ingestionId: claimed.id,
      contactId: result.contactId,
      leadId: result.leadId,
      touchpointId: result.touchpointId,
    };
  } catch (err) {
    const sanitized = sanitizeErrorMessage(err);
    await repo.markFailed(claimed.id, sanitized);
    return { outcome: "failed", ingestionId: claimed.id, errorMessage: sanitized };
  }
}
