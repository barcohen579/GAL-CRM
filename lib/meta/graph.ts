// Meta Graph API helper for Lead Ads ingestion. Server-only. Every call
// in this file is READ-ONLY (GET) — nothing here creates, edits,
// subscribes, or deletes anything in Meta. IMPORTANT: fetchLeadByLeadgenId
// returns field_data (the lead's actual PII) — callers must never log
// the returned record; only pass it to lib/meta/field-data.ts for
// extraction and onward to Supabase writes.

// Matches scripts/meta-sync.mjs's META_API_VERSION — reused rather than
// picked independently, per project convention (see AGENTS.md: use the
// current Graph API version already used by the project).
const META_API_VERSION = "v21.0";

// Conservative timeout for every Graph API call this pipeline makes.
// Real calls here (derive Page token, fetch one lead) are small and
// fast; 10s is generous headroom for a slow network without leaving a
// webhook POST hanging indefinitely on a Meta-side outage. On timeout
// the caller's error is a plain "timed out" message — never the
// request URL/token — and the caller (lib/meta/ingest.ts) marks the
// ingestion row FAILED and retryable rather than retrying here: an
// automatic retry loop inside this file would risk making duplicate
// Graph API calls per webhook delivery for no idempotency benefit
// (Meta's own field_data fetch has no side effects to duplicate, but a
// retry-storm here could still trip Meta's rate limits) — the existing
// FAILED/retryable design (Meta's own webhook redelivery, or the
// manual reprocessing script) is the chosen retry mechanism instead.
export const META_REQUEST_TIMEOUT_MS = 10_000;

type MetaApiError = { type?: string; code?: number; message?: string };

// Shared timeout wrapper so both the primary request and the
// pagination follow-up (below) get the same guarantee. Never includes
// the request URL or token in a thrown message — only a fixed,
// human-readable description.
export async function fetchWithTimeout(url: string | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), META_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Meta API request timed out after ${META_REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function metaGet<T extends Record<string, unknown>>(
  pathPart: string,
  params: Record<string, string>,
  token: string
): Promise<T> {
  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}${pathPart}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json()) as T & { error?: MetaApiError };

  if (!res.ok || json.error) {
    const err = json.error ?? {};
    throw new Error(
      `Meta API error (HTTP ${res.status}): ${err.type ?? "unknown"} ${err.code ?? ""} — ${
        err.message ?? "no message"
      }`
    );
  }
  return json;
}

export type PageTokenDeriver = (pageId: string) => Promise<string>;

// Derives a Page Access Token for `pageId` from the permanent System
// User token, read-only (GET /me/accounts). Required because the
// leadgen_forms / lead-detail endpoints reject the raw System User
// token with "(#190) This method must be called with a Page Access
// Token" — verified live during Phase 3B readiness checks. Never
// caches the derived token across calls: this integration's lead
// volume is low, and re-deriving avoids ever holding a stale token.
type MetaAccountsPage = { id: string; access_token?: string };
type MetaAccountsResponse = {
  data?: MetaAccountsPage[];
  paging?: { next?: string };
};

export function makePageAccessTokenDeriver(systemUserToken: string): PageTokenDeriver {
  return async (pageId: string) => {
    const first = await metaGet<MetaAccountsResponse>(
      "/me/accounts",
      { fields: "id,access_token", limit: "200" },
      systemUserToken
    );

    const pages: MetaAccountsPage[] = Array.isArray(first.data) ? first.data : [];

    // Defensive pagination handling in case the System User is ever
    // granted access to more than one page of results.
    let nextUrl: string | undefined = first.paging?.next;
    let pageCount = 1;
    while (nextUrl) {
      const res = await fetchWithTimeout(nextUrl);
      const nextJson = await res.json();
      if (nextJson.error) {
        throw new Error(
          `Meta API pagination error deriving page token: ${nextJson.error.message ?? ""}`
        );
      }
      pages.push(...(nextJson.data ?? []));
      nextUrl = nextJson.paging?.next;
      pageCount += 1;
      if (pageCount > 20) {
        throw new Error("Meta API /me/accounts pagination exceeded 20 pages — aborting.");
      }
    }

    const match = pages.find((p) => p.id === pageId);
    if (!match?.access_token) {
      throw new Error(
        `No Page Access Token available for page ${pageId} — is it still granted to this System User?`
      );
    }
    return match.access_token;
  };
}

export type MetaFieldDatum = { name: string; values: string[] };

export type MetaLeadRecord = {
  id: string;
  createdTimeIso: string | null;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  formId: string | null;
  fieldData: MetaFieldDatum[];
};

export type FetchLeadFn = (leadgenId: string, pageAccessToken: string) => Promise<MetaLeadRecord>;

// Fetches one lead's submission by id, read-only (GET /{leadgen_id}).
// This is the only call in the whole ingestion pipeline that returns
// field_data (PII) — see the file-level warning above.
type MetaLeadDetailResponse = {
  id: string;
  created_time?: string;
  ad_id?: string;
  adgroup_id?: string;
  campaign_id?: string;
  form_id?: string;
  field_data?: MetaFieldDatum[];
};

export const fetchLeadByLeadgenId: FetchLeadFn = async (leadgenId, pageAccessToken) => {
  const json = await metaGet<MetaLeadDetailResponse>(
    `/${leadgenId}`,
    { fields: "id,created_time,ad_id,adgroup_id,campaign_id,form_id,field_data" },
    pageAccessToken
  );
  return {
    id: json.id,
    createdTimeIso: typeof json.created_time === "string" ? json.created_time : null,
    adId: json.ad_id ?? null,
    adsetId: json.adgroup_id ?? null,
    campaignId: json.campaign_id ?? null,
    formId: json.form_id ?? null,
    fieldData: Array.isArray(json.field_data) ? json.field_data : [],
  };
};
