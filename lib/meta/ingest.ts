// Core Meta Lead Ads ingestion orchestration — used identically by the
// webhook route (app/api/meta/leadgen-webhook/route.ts) and the manual
// reprocessing script (scripts/meta-reprocess-lead.ts), so both paths
// share one implementation of "process exactly one leadgen_id safely".
//
// SYNCHRONOUS PROCESSING DESIGN DECISION (Phase 3B spec item 6):
// This module processes a lead fully within the caller's request/
// invocation — no queue, no background worker. The webhook route
// awaits processOneLeadgenId() and returns HTTP 500 if it failed (so
// Meta's own webhook delivery retries with its own backoff — free
// retry semantics, no infrastructure required) or 200 if it succeeded
// or was a legitimate duplicate. This is deliberately the simplest
// reliable option for this integration's actual scale (one Page, a
// personal-training business's lead volume — not high-throughput):
//   - Processing is fast: at most two Meta GETs (derive Page token,
//     fetch one lead) plus a handful of small Supabase reads/writes —
//     comfortably inside a Route Handler's normal execution budget.
//   - meta_lead_ingestions.status already gives full retry visibility
//     (PENDING/FAILED rows are safely retryable — see
//     processOneLeadgenId below) without needing separate queue state.
//   - The reprocessing script is the durable backstop for the rare
//     case where Meta's own delivery retries are exhausted before a
//     transient failure (e.g. Meta API hiccup) resolves.
// A queue/worker design was deliberately NOT built — it would add real
// operational complexity (a job table, a worker process or cron, at-
// least-once delivery semantics to reason about) for no benefit at this
// integration's volume. If lead volume or processing latency ever grows
// enough that synchronous handling becomes risky, migrating to
// "insert PENDING row and return 200 immediately, process from a
// separate worker" is possible without changing this file's core
// logic — only the caller (the route handler) would change.

import { normalizePhone, normalizeEmail } from "./normalize.ts";
import { extractLeadFields } from "./field-data.ts";
import type { PageTokenDeriver, FetchLeadFn, MetaLeadRecord } from "./graph.ts";
import type { IngestionRow, MetaIngestionRepo, NewIngestionFields } from "./repo.ts";
import { CONTACT_CANDIDATE_LIMIT } from "./repo.ts";

// ------------------------------------------------------------------
// Contact + lead + touchpoint matching/creation
// ------------------------------------------------------------------

export type MatchAndCreateInput = {
  fullName: string;
  phone: string | null;
  email: string | null;
  leadgenId: string;
  occurredAt: string | null;
  sourceDetail: string;
  metadata: Record<string, unknown> | null;
};

export type MatchAndCreateResult = {
  contactId: string;
  leadId: string;
  touchpointId: string;
  createdNewContact: boolean;
  createdNewLead: boolean;
  wasDuplicate: boolean;
};

// Matching rules (Phase 3B spec item 7):
//   1. normalized phone first
//   2. normalized email second
//   3. NEVER fuzzy-match by name
// If a match is found, missing (null) phone/email fields are filled in
// — existing data is never overwritten (see repo.fillMissingContactFields).
//
// Lead reuse rule (item 8): an OPEN lead (stage not WON/LOST) for the
// matched/created contact is reused as-is (stage never reset); a new
// lead is created only when none exists or every existing lead is
// closed.
//
// Touchpoint rule (item 9): exactly one per leadgen_id — enforced first
// by checking for an existing touchpoint with this external_ref before
// doing anything else, so this whole function is safe to call more
// than once for the same leadgenId (defense in depth on top of the
// meta_lead_ingestions-row-level idempotency guard in
// processOneLeadgenId below).
export async function matchAndCreateCrmEntities(
  repo: MetaIngestionRepo,
  input: MatchAndCreateInput
): Promise<MatchAndCreateResult> {
  const existingTouchpoint = await repo.findTouchpointByExternalRef(input.leadgenId);
  if (existingTouchpoint) {
    const contactId = await repo.getLeadContactId(existingTouchpoint.leadId);
    if (!contactId) {
      throw new Error(
        "Existing touchpoint references a lead with no contact_id — data integrity issue."
      );
    }
    return {
      contactId,
      leadId: existingTouchpoint.leadId,
      touchpointId: existingTouchpoint.id,
      createdNewContact: false,
      createdNewLead: false,
      wasDuplicate: true,
    };
  }

  const normalizedPhone = normalizePhone(input.phone);
  const normalizedEmail = normalizeEmail(input.email);

  let contactId: string | null = null;

  if (normalizedPhone) {
    const candidates = await repo.getContactsWithPhone(CONTACT_CANDIDATE_LIMIT);
    const match = candidates.find((c) => normalizePhone(c.phone) === normalizedPhone);
    if (match) contactId = match.id;
  }
  if (!contactId && normalizedEmail) {
    const candidates = await repo.getContactsWithEmail(CONTACT_CANDIDATE_LIMIT);
    const match = candidates.find((c) => normalizeEmail(c.email) === normalizedEmail);
    if (match) contactId = match.id;
  }
  // Deliberately no name-based fallback here — never fuzzy-match by name.

  let createdNewContact = false;
  if (contactId) {
    await repo.fillMissingContactFields(contactId, { phone: input.phone, email: input.email });
  } else {
    contactId = await repo.createContact({
      fullName: input.fullName,
      phone: input.phone,
      email: input.email,
    });
    createdNewContact = true;
  }

  let leadId = await repo.findOpenLeadIdForContact(contactId);
  let createdNewLead = false;
  if (!leadId) {
    leadId = await repo.createLead(contactId);
    createdNewLead = true;
  }

  const isFirstTouchpoint = !(await repo.leadHasAnyTouchpoint(leadId));
  const touchpointId = await repo.createTouchpoint({
    leadId,
    externalRef: input.leadgenId,
    occurredAt: input.occurredAt,
    sourceDetail: input.sourceDetail,
    metadata: input.metadata,
    isPrimary: isFirstTouchpoint,
  });

  return { contactId, leadId, touchpointId, createdNewContact, createdNewLead, wasDuplicate: false };
}

// ------------------------------------------------------------------
// Top-level per-leadgen_id orchestration
// ------------------------------------------------------------------

export type ProcessDeps = {
  derivePageAccessToken: PageTokenDeriver;
  fetchLead: FetchLeadFn;
};

export type ProcessOutcome =
  | {
      outcome: "processed";
      ingestionId: string;
      contactId: string;
      leadId: string;
      touchpointId: string;
    }
  | {
      outcome: "duplicate";
      ingestionId: string;
      contactId: string | null;
      leadId: string | null;
      touchpointId: string | null;
    }
  | { outcome: "in_progress_elsewhere"; ingestionId: string }
  | { outcome: "failed"; ingestionId: string; errorMessage: string };

const FALLBACK_FULL_NAME = "ליד ממטא (ללא שם)"; // contacts.full_name is NOT NULL; Meta almost
// always supplies a name, but this guarantees the constraint is met on
// the rare submission that doesn't.

function buildTouchpointMetadata(
  row: IngestionRow,
  lead: MetaLeadRecord
): Record<string, unknown> | null {
  const meta: Record<string, unknown> = {};
  const formId = lead.formId ?? row.meta_form_id;
  const adId = lead.adId ?? row.meta_ad_id;
  const adsetId = lead.adsetId ?? row.meta_adset_id;
  const campaignId = lead.campaignId ?? row.meta_campaign_id;

  if (row.meta_page_id) meta.pageId = row.meta_page_id;
  if (formId) meta.formId = formId;
  if (adId) meta.adId = adId;
  if (adsetId) meta.adsetId = adsetId;
  if (campaignId) meta.campaignId = campaignId;

  return Object.keys(meta).length > 0 ? meta : null;
}

// Never includes PII: every error this pipeline throws is already
// constructed without touching field_data (Meta API errors describe
// permission/rate/validation issues; Supabase errors describe
// constraint/permission issues; our own validation errors are authored
// text). The redaction patterns below are defense-in-depth on top of
// that, not the primary safeguard.
export function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const truncated = raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
  return truncated
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[redacted-email]")
    .replace(/\d{7,}/g, "[redacted-digits]");
}

// Processes exactly one Meta lead submission end to end:
//   1. Find (or, given webhookFields, create) the meta_lead_ingestions
//      row for this leadgen_id.
//   2. If it's already terminal-successful (PROCESSED /
//      DUPLICATE_IGNORED), return "duplicate" without touching CRM data.
//   3. Atomically claim it for processing (PENDING/FAILED -> PROCESSING).
//      If the claim fails (another delivery is already mid-flight or
//      just finished), return "duplicate" or "in_progress_elsewhere"
//      without doing any work.
//   4. Derive the Page Access Token, fetch the lead, extract fields,
//      match/create the Contact -> Lead -> Touchpoint, and mark the row
//      PROCESSED (or DUPLICATE_IGNORED if matchAndCreateCrmEntities
//      itself found this leadgen_id already fully processed under the
//      entity-level guard).
//   5. On any failure, mark the row FAILED with a sanitized message and
//      leave it retryable (see the module-level design note above).
export async function processOneLeadgenId(
  repo: MetaIngestionRepo,
  leadgenId: string,
  webhookFields: NewIngestionFields | null,
  deps: ProcessDeps
): Promise<ProcessOutcome> {
  let row = await repo.getIngestionRowByLeadgenId(leadgenId);

  if (!row) {
    if (!webhookFields) {
      throw new Error(
        `No meta_lead_ingestions row exists for leadgen_id ${leadgenId} and no webhook ` +
          "data was supplied to create one (reprocessing an unknown leadgen_id is not supported)."
      );
    }
    row = await repo.insertIngestionRow(leadgenId, webhookFields);
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
    const pageAccessToken = await deps.derivePageAccessToken(claimed.meta_page_id);
    const lead = await deps.fetchLead(leadgenId, pageAccessToken);
    const fields = extractLeadFields(lead.fieldData);

    const result = await matchAndCreateCrmEntities(repo, {
      fullName: fields.fullName ?? FALLBACK_FULL_NAME,
      phone: fields.phone,
      email: fields.email,
      leadgenId,
      occurredAt: lead.createdTimeIso ?? claimed.received_at,
      sourceDetail: "ליד מפרסומת Meta (Lead Ads)",
      metadata: buildTouchpointMetadata(claimed, lead),
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
