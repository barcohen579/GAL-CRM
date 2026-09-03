// In-memory fakes implementing MetaIngestionRepo (and a fake Meta lead
// fetcher) for tests. No network, no database — used only by
// lib/meta/*.test.ts. Mirrors real behavior closely enough to exercise
// lib/meta/ingest.ts's actual logic (idempotency, matching, claiming),
// not just its happy path.

import type {
  ContactMatchCandidate,
  CreateTouchpointInput,
  IngestionRow,
  IngestionStatus,
  MetaIngestionRepo,
  NewIngestionFields,
} from "./repo.ts";
import type { MetaLeadRecord } from "./graph.ts";

type FakeContact = { id: string; full_name: string; phone: string | null; email: string | null };
type FakeLead = { id: string; contact_id: string; stage: string };
type FakeTouchpoint = {
  id: string;
  lead_id: string;
  external_ref: string;
  channel: string;
  is_primary: boolean;
};

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export type FakeDb = {
  ingestions: Map<string, IngestionRow>; // keyed by id
  contacts: Map<string, FakeContact>;
  leads: Map<string, FakeLead>;
  touchpoints: Map<string, FakeTouchpoint>;
};

export function createFakeDb(): FakeDb {
  return {
    ingestions: new Map(),
    contacts: new Map(),
    leads: new Map(),
    touchpoints: new Map(),
  };
}

export function seedContact(
  db: FakeDb,
  input: { fullName: string; phone?: string | null; email?: string | null }
): string {
  const id = nextId("contact");
  db.contacts.set(id, {
    id,
    full_name: input.fullName,
    phone: input.phone ?? null,
    email: input.email ?? null,
  });
  return id;
}

export function seedLead(db: FakeDb, contactId: string, stage: string): string {
  const id = nextId("lead");
  db.leads.set(id, { id, contact_id: contactId, stage });
  return id;
}

export function createFakeMetaIngestionRepo(db: FakeDb): MetaIngestionRepo {
  return {
    async getIngestionRowByLeadgenId(leadgenId) {
      for (const row of db.ingestions.values()) {
        if (row.leadgen_id === leadgenId) return { ...row };
      }
      return null;
    },

    async getIngestionRowById(id) {
      const row = db.ingestions.get(id);
      return row ? { ...row } : null;
    },

    async insertIngestionRow(leadgenId, fields: NewIngestionFields) {
      const id = nextId("ingestion");
      const row: IngestionRow = {
        id,
        leadgen_id: leadgenId,
        meta_page_id: fields.metaPageId,
        meta_form_id: fields.metaFormId,
        meta_ad_id: fields.metaAdId,
        meta_adset_id: fields.metaAdsetId,
        meta_campaign_id: fields.metaCampaignId,
        received_at: fields.receivedAt,
        processed_at: null,
        status: "PENDING",
        error_message: null,
        contact_id: null,
        lead_id: null,
        touchpoint_id: null,
      };
      db.ingestions.set(id, row);
      return { ...row };
    },

    async claimForProcessing(id) {
      const row = db.ingestions.get(id);
      if (!row) return null;
      if (row.status !== "PENDING" && row.status !== "FAILED") return null;
      row.status = "PROCESSING";
      return { ...row };
    },

    async markProcessed(id, ids) {
      const row = db.ingestions.get(id);
      if (!row) throw new Error("fake: markProcessed on unknown id");
      row.status = "PROCESSED" as IngestionStatus;
      row.contact_id = ids.contactId;
      row.lead_id = ids.leadId;
      row.touchpoint_id = ids.touchpointId;
      row.processed_at = new Date().toISOString();
      row.error_message = null;
    },

    async markDuplicate(id, ids) {
      const row = db.ingestions.get(id);
      if (!row) throw new Error("fake: markDuplicate on unknown id");
      row.status = "DUPLICATE_IGNORED" as IngestionStatus;
      row.contact_id = ids.contactId;
      row.lead_id = ids.leadId;
      row.touchpoint_id = ids.touchpointId;
      row.processed_at = new Date().toISOString();
      row.error_message = null;
    },

    async markFailed(id, sanitizedErrorMessage) {
      const row = db.ingestions.get(id);
      if (!row) throw new Error("fake: markFailed on unknown id");
      row.status = "FAILED" as IngestionStatus;
      row.error_message = sanitizedErrorMessage;
      row.processed_at = null;
    },

    async getContactsWithPhone(limit) {
      return [...db.contacts.values()]
        .filter((c) => c.phone !== null)
        .slice(0, limit)
        .map((c): ContactMatchCandidate => ({ id: c.id, phone: c.phone, email: c.email }));
    },

    async getContactsWithEmail(limit) {
      return [...db.contacts.values()]
        .filter((c) => c.email !== null)
        .slice(0, limit)
        .map((c): ContactMatchCandidate => ({ id: c.id, phone: c.phone, email: c.email }));
    },

    async createContact(input) {
      const id = nextId("contact");
      db.contacts.set(id, {
        id,
        full_name: input.fullName,
        phone: input.phone,
        email: input.email,
      });
      return id;
    },

    async fillMissingContactFields(contactId, input) {
      const contact = db.contacts.get(contactId);
      if (!contact) throw new Error("fake: fillMissingContactFields on unknown contact");
      if (!contact.phone && input.phone) contact.phone = input.phone;
      if (!contact.email && input.email) contact.email = input.email;
    },

    async findOpenLeadIdForContact(contactId) {
      const openLeads = [...db.leads.values()]
        .filter((l) => l.contact_id === contactId && l.stage !== "WON" && l.stage !== "LOST");
      return openLeads.length > 0 ? openLeads[openLeads.length - 1].id : null;
    },

    async createLead(contactId) {
      const id = nextId("lead");
      db.leads.set(id, { id, contact_id: contactId, stage: "NEW" });
      return id;
    },

    async getLeadContactId(leadId) {
      return db.leads.get(leadId)?.contact_id ?? null;
    },

    async findTouchpointByExternalRef(externalRef) {
      for (const tp of db.touchpoints.values()) {
        if (tp.external_ref === externalRef && tp.channel === "META_AD") {
          return { id: tp.id, leadId: tp.lead_id };
        }
      }
      return null;
    },

    async leadHasAnyTouchpoint(leadId) {
      return [...db.touchpoints.values()].some((tp) => tp.lead_id === leadId);
    },

    async createTouchpoint(input: CreateTouchpointInput) {
      const id = nextId("touchpoint");
      db.touchpoints.set(id, {
        id,
        lead_id: input.leadId,
        external_ref: input.externalRef,
        channel: "META_AD",
        is_primary: input.isPrimary,
      });
      return id;
    },
  };
}

export function makeFakeFetchLead(record: Partial<MetaLeadRecord> & { fieldData: MetaLeadRecord["fieldData"] }) {
  return async (): Promise<MetaLeadRecord> => ({
    id: record.id ?? "fake-lead-id",
    createdTimeIso: record.createdTimeIso ?? null,
    adId: record.adId ?? null,
    adsetId: record.adsetId ?? null,
    campaignId: record.campaignId ?? null,
    formId: record.formId ?? null,
    fieldData: record.fieldData,
  });
}

export async function fakeDerivePageAccessToken(): Promise<string> {
  return "fake-page-access-token";
}
