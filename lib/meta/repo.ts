import type { SupabaseClient } from "@supabase/supabase-js";

// Data-access layer for Meta lead ingestion, expressed as an interface
// (MetaIngestionRepo) rather than direct Supabase calls sprinkled
// through lib/meta/ingest.ts. This is what makes the ingestion/matching
// LOGIC unit-testable without a live database: tests implement this
// same interface with a small in-memory fake (see lib/meta/ingest.test.ts)
// while createSupabaseMetaIngestionRepo below is the only real
// implementation, used by the webhook route and the reprocessing
// script — both via the service_role admin client (see
// lib/supabase/admin.ts). Never used with the anon/user client.

export type IngestionStatus =
  | "PENDING"
  | "PROCESSING"
  | "PROCESSED"
  | "FAILED"
  | "DUPLICATE_IGNORED";

export type IngestionRow = {
  id: string;
  leadgen_id: string;
  meta_page_id: string;
  meta_form_id: string | null;
  meta_ad_id: string | null;
  meta_adset_id: string | null;
  meta_campaign_id: string | null;
  received_at: string;
  processed_at: string | null;
  status: IngestionStatus;
  error_message: string | null;
  contact_id: string | null;
  lead_id: string | null;
  touchpoint_id: string | null;
};

export type NewIngestionFields = {
  metaPageId: string;
  metaFormId: string | null;
  metaAdId: string | null;
  metaAdsetId: string | null;
  metaCampaignId: string | null;
  receivedAt: string; // ISO
  rawPayload: Record<string, unknown> | null;
};

export type ContactMatchCandidate = { id: string; phone: string | null; email: string | null };

export type CreateTouchpointInput = {
  leadId: string;
  externalRef: string;
  occurredAt: string | null;
  sourceDetail: string;
  metadata: Record<string, unknown> | null;
  isPrimary: boolean;
};

export interface MetaIngestionRepo {
  // meta_lead_ingestions
  getIngestionRowByLeadgenId(leadgenId: string): Promise<IngestionRow | null>;
  getIngestionRowById(id: string): Promise<IngestionRow | null>;
  insertIngestionRow(leadgenId: string, fields: NewIngestionFields): Promise<IngestionRow>;
  /** Atomic conditional UPDATE: PENDING/FAILED -> PROCESSING. Returns
   *  null (claims nothing) if the row is no longer in a claimable
   *  status — the caller must treat that as "someone else is handling
   *  it / it already finished", never retry the claim itself. */
  claimForProcessing(id: string): Promise<IngestionRow | null>;
  markProcessed(
    id: string,
    ids: { contactId: string; leadId: string; touchpointId: string }
  ): Promise<void>;
  markDuplicate(
    id: string,
    ids: { contactId: string; leadId: string; touchpointId: string }
  ): Promise<void>;
  markFailed(id: string, sanitizedErrorMessage: string): Promise<void>;

  // contacts
  getContactsWithPhone(limit: number): Promise<ContactMatchCandidate[]>;
  getContactsWithEmail(limit: number): Promise<ContactMatchCandidate[]>;
  createContact(input: { fullName: string; phone: string | null; email: string | null }): Promise<string>;
  /** Fills phone/email ONLY where the existing column is currently
   *  null — never overwrites a contact's existing data. */
  fillMissingContactFields(
    contactId: string,
    input: { phone: string | null; email: string | null }
  ): Promise<void>;

  // leads
  findOpenLeadIdForContact(contactId: string): Promise<string | null>;
  createLead(contactId: string): Promise<string>;
  getLeadContactId(leadId: string): Promise<string | null>;

  // touchpoints
  findTouchpointByExternalRef(externalRef: string): Promise<{ id: string; leadId: string } | null>;
  leadHasAnyTouchpoint(leadId: string): Promise<boolean>;
  createTouchpoint(input: CreateTouchpointInput): Promise<string>;
}

// Bound on how many existing contacts we read back for in-app
// normalized phone/email comparison (see lib/meta/ingest.ts). This CRM
// is a single-operator personal-training business — its full contact
// list is realistically small (tens to low hundreds), so a bounded
// full-column read is simple, correct, and fast at this scale. If the
// contact list ever grows large enough for this to matter, the fix is
// a normalized indexed column on contacts — deliberately not built
// here (see Phase 3B report) to avoid speculative schema complexity.
export const CONTACT_CANDIDATE_LIMIT = 5000;

// Supabase's untyped client (this project has no generated Database
// type — see lib/crm/types.ts's own "hand-written, not codegen" note)
// returns query results typed loosely. This function's job is purely
// to pick out the exact columns we selected, shaped as IngestionRow —
// it is not a validation layer.
function mapIngestionRow(row: IngestionRow): IngestionRow {
  return {
    id: row.id,
    leadgen_id: row.leadgen_id,
    meta_page_id: row.meta_page_id,
    meta_form_id: row.meta_form_id,
    meta_ad_id: row.meta_ad_id,
    meta_adset_id: row.meta_adset_id,
    meta_campaign_id: row.meta_campaign_id,
    received_at: row.received_at,
    processed_at: row.processed_at,
    status: row.status,
    error_message: row.error_message,
    contact_id: row.contact_id,
    lead_id: row.lead_id,
    touchpoint_id: row.touchpoint_id,
  };
}

export function createSupabaseMetaIngestionRepo(supabase: SupabaseClient): MetaIngestionRepo {
  return {
    async getIngestionRowByLeadgenId(leadgenId) {
      const { data, error } = await supabase
        .from("meta_lead_ingestions")
        .select(
          "id, leadgen_id, meta_page_id, meta_form_id, meta_ad_id, meta_adset_id, meta_campaign_id, received_at, processed_at, status, error_message, contact_id, lead_id, touchpoint_id"
        )
        .eq("leadgen_id", leadgenId)
        .maybeSingle();
      if (error) throw new Error(`meta_lead_ingestions lookup failed: ${error.message}`);
      return data ? mapIngestionRow(data) : null;
    },

    async getIngestionRowById(id) {
      const { data, error } = await supabase
        .from("meta_lead_ingestions")
        .select(
          "id, leadgen_id, meta_page_id, meta_form_id, meta_ad_id, meta_adset_id, meta_campaign_id, received_at, processed_at, status, error_message, contact_id, lead_id, touchpoint_id"
        )
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`meta_lead_ingestions lookup by id failed: ${error.message}`);
      return data ? mapIngestionRow(data) : null;
    },

    async insertIngestionRow(leadgenId, fields) {
      const { data, error } = await supabase
        .from("meta_lead_ingestions")
        .insert({
          leadgen_id: leadgenId,
          meta_page_id: fields.metaPageId,
          meta_form_id: fields.metaFormId,
          meta_ad_id: fields.metaAdId,
          meta_adset_id: fields.metaAdsetId,
          meta_campaign_id: fields.metaCampaignId,
          received_at: fields.receivedAt,
          status: "PENDING",
          raw_payload: fields.rawPayload,
        })
        .select(
          "id, leadgen_id, meta_page_id, meta_form_id, meta_ad_id, meta_adset_id, meta_campaign_id, received_at, processed_at, status, error_message, contact_id, lead_id, touchpoint_id"
        )
        .single();

      if (error) {
        // Unique-violation race: another concurrent delivery for the
        // same leadgen_id inserted first. Re-read rather than error —
        // this delivery is a legitimate duplicate, not a failure.
        if (error.code === "23505") {
          const existing = await this.getIngestionRowByLeadgenId(leadgenId);
          if (existing) return existing;
        }
        throw new Error(`meta_lead_ingestions insert failed: ${error.message}`);
      }
      return mapIngestionRow(data);
    },

    async claimForProcessing(id) {
      const { data, error } = await supabase
        .from("meta_lead_ingestions")
        .update({ status: "PROCESSING" })
        .eq("id", id)
        .in("status", ["PENDING", "FAILED"])
        .select(
          "id, leadgen_id, meta_page_id, meta_form_id, meta_ad_id, meta_adset_id, meta_campaign_id, received_at, processed_at, status, error_message, contact_id, lead_id, touchpoint_id"
        )
        .maybeSingle();
      if (error) throw new Error(`meta_lead_ingestions claim failed: ${error.message}`);
      return data ? mapIngestionRow(data) : null;
    },

    async markProcessed(id, ids) {
      const { error } = await supabase
        .from("meta_lead_ingestions")
        .update({
          status: "PROCESSED",
          contact_id: ids.contactId,
          lead_id: ids.leadId,
          touchpoint_id: ids.touchpointId,
          processed_at: new Date().toISOString(),
          error_message: null,
        })
        .eq("id", id);
      if (error) throw new Error(`meta_lead_ingestions markProcessed failed: ${error.message}`);
    },

    async markDuplicate(id, ids) {
      const { error } = await supabase
        .from("meta_lead_ingestions")
        .update({
          status: "DUPLICATE_IGNORED",
          contact_id: ids.contactId,
          lead_id: ids.leadId,
          touchpoint_id: ids.touchpointId,
          processed_at: new Date().toISOString(),
          error_message: null,
        })
        .eq("id", id);
      if (error) throw new Error(`meta_lead_ingestions markDuplicate failed: ${error.message}`);
    },

    async markFailed(id, sanitizedErrorMessage) {
      const { error } = await supabase
        .from("meta_lead_ingestions")
        .update({
          status: "FAILED",
          error_message: sanitizedErrorMessage,
          processed_at: null,
        })
        .eq("id", id);
      if (error) throw new Error(`meta_lead_ingestions markFailed failed: ${error.message}`);
    },

    async getContactsWithPhone(limit) {
      const { data, error } = await supabase
        .from("contacts")
        .select("id, phone, email")
        .not("phone", "is", null)
        .limit(limit);
      if (error) throw new Error(`contacts phone candidate lookup failed: ${error.message}`);
      return (data ?? []) as ContactMatchCandidate[];
    },

    async getContactsWithEmail(limit) {
      const { data, error } = await supabase
        .from("contacts")
        .select("id, phone, email")
        .not("email", "is", null)
        .limit(limit);
      if (error) throw new Error(`contacts email candidate lookup failed: ${error.message}`);
      return (data ?? []) as ContactMatchCandidate[];
    },

    async createContact(input) {
      const { data, error } = await supabase
        .from("contacts")
        .insert({ full_name: input.fullName, phone: input.phone, email: input.email })
        .select("id")
        .single();
      if (error || !data) throw new Error(`contact creation failed: ${error?.message ?? "no row returned"}`);
      return data.id as string;
    },

    async fillMissingContactFields(contactId, input) {
      // Read-then-conditionally-write rather than a blind update, so we
      // never overwrite a contact's existing phone/email with the
      // incoming value — only ever fill in what was missing.
      const { data: existing, error: readError } = await supabase
        .from("contacts")
        .select("phone, email")
        .eq("id", contactId)
        .single();
      if (readError || !existing) {
        throw new Error(`contact lookup before fill-in failed: ${readError?.message ?? "not found"}`);
      }

      const patch: Record<string, string> = {};
      if (!existing.phone && input.phone) patch.phone = input.phone;
      if (!existing.email && input.email) patch.email = input.email;
      if (Object.keys(patch).length === 0) return;

      const { error } = await supabase.from("contacts").update(patch).eq("id", contactId);
      if (error) throw new Error(`contact fill-in update failed: ${error.message}`);
    },

    async findOpenLeadIdForContact(contactId) {
      const { data, error } = await supabase
        .from("leads")
        .select("id")
        .eq("contact_id", contactId)
        .not("stage", "in", "(WON,LOST)")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`open lead lookup failed: ${error.message}`);
      return data?.id ?? null;
    },

    async createLead(contactId) {
      const { data, error } = await supabase
        .from("leads")
        .insert({ contact_id: contactId })
        .select("id")
        .single();
      if (error || !data) throw new Error(`lead creation failed: ${error?.message ?? "no row returned"}`);
      return data.id as string;
    },

    async getLeadContactId(leadId) {
      const { data, error } = await supabase
        .from("leads")
        .select("contact_id")
        .eq("id", leadId)
        .maybeSingle();
      if (error) throw new Error(`lead contact_id lookup failed: ${error.message}`);
      return data?.contact_id ?? null;
    },

    async findTouchpointByExternalRef(externalRef) {
      const { data, error } = await supabase
        .from("touchpoints")
        .select("id, lead_id")
        .eq("external_ref", externalRef)
        .eq("channel", "META_AD")
        .maybeSingle();
      if (error) throw new Error(`touchpoint idempotency lookup failed: ${error.message}`);
      return data ? { id: data.id as string, leadId: data.lead_id as string } : null;
    },

    async leadHasAnyTouchpoint(leadId) {
      const { count, error } = await supabase
        .from("touchpoints")
        .select("id", { count: "exact", head: true })
        .eq("lead_id", leadId);
      if (error) throw new Error(`touchpoint existence check failed: ${error.message}`);
      return (count ?? 0) > 0;
    },

    async createTouchpoint(input) {
      const { data, error } = await supabase
        .from("touchpoints")
        .insert({
          lead_id: input.leadId,
          channel: "META_AD",
          certainty: "CONFIRMED",
          occurred_at: input.occurredAt,
          source_detail: input.sourceDetail,
          external_ref: input.externalRef,
          is_primary: input.isPrimary,
          metadata: input.metadata,
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(`touchpoint creation failed: ${error?.message ?? "no row returned"}`);
      return data.id as string;
    },
  };
}
