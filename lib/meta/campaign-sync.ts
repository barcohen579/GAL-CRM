import type { SupabaseClient } from "@supabase/supabase-js";

// GAL CRM — Meta Marketing API daily campaign sync, extracted from
// scripts/meta-sync.mjs so the SAME production-tested logic is callable
// both from that CLI script (manual/backfill runs) and from
// app/api/meta/sync/trigger/route.ts (the automatic Dashboard-triggered
// refresh — see lib/meta/sync-orchestrator.ts). This file is the single
// source of truth for "how a Meta campaign-spend sync actually works";
// nothing here should ever diverge between the two callers.
//
// TRUSTED SERVER-ONLY CODE. Never import this from a Server Component or
// anything reachable from the browser — it expects to be handed a
// service-role (or otherwise trusted) Supabase client and a real
// META_ACCESS_TOKEN by its caller. See scripts/meta-sync.mjs and
// app/api/meta/sync/trigger/route.ts for the two legitimate callers.
//
// What it does, for EACH configured ad account independently:
//   1. Fetches the account's own metadata from Meta first — in
//      particular its reporting timezone_name. Different ad accounts
//      can have different timezones (verified live: one GAL ad account
//      is Asia/Jerusalem, another is America/Los_Angeles) — this never
//      assumes a single shared timezone.
//   2. Calls the real Meta Marketing API for campaign-level Insights,
//      with time_increment=1 so each row is a single day, using a
//      trailing-7-completed-days window computed in THAT account's own
//      timezone (or an explicit range, applied identically to every
//      configured account, for manual/backfill runs).
//   3. Converts each row's decimal ILS spend to integer agorot.
//   4. Upserts one row per (ad account, campaign, day) into
//      public.meta_campaign_daily_metrics, keyed on the table's unique
//      constraint — safe to run repeatedly for the same range.
//
// A failure on one account does not abort the others — each account's
// pipeline is independently try/caught; the caller decides what to do
// with a partial failure (runMetaCampaignSync's own `success` flag is
// false whenever ANY account failed).

const META_API_VERSION = "v21.0";

// ------------------------------------------------------------------
// Multi-account config
// ------------------------------------------------------------------

function normalizeAccountId(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("act_") ? trimmed : `act_${trimmed}`;
}

// Reads META_AD_ACCOUNT_IDS (comma-separated, e.g. "act_123,act_456"),
// falling back to the older singular META_AD_ACCOUNT_ID for backward
// compatibility with a single-account setup. Both of GAL CRM's
// configured accounts (act_2070492616442158, act_101145727) come from
// this env var — never hardcoded here or anywhere else.
export function resolveConfiguredAccountIds(
  env: Record<string, string | undefined> = process.env
): string[] {
  const plural = env.META_AD_ACCOUNT_IDS;
  if (plural && plural.trim().length > 0) {
    return plural
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(normalizeAccountId);
  }
  const singular = env.META_AD_ACCOUNT_ID;
  if (singular && singular.trim().length > 0) {
    return [normalizeAccountId(singular)];
  }
  return [];
}

// ------------------------------------------------------------------
// Date-range resolution — per account, in THAT account's own timezone.
// ------------------------------------------------------------------

// Returns YYYY-MM-DD for "now" in the given IANA timezone, using Intl so
// this is correct across DST without a date library dependency.
function todayInTimezone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type DateRange = { since: string; until: string; mode: string };

// argv-supplied explicit range applies identically to every account (the
// smallest safe design for manual/backfill runs). Only the DEFAULT (no
// explicit range) path varies per account, since that's the one case
// where "yesterday" genuinely differs by timezone.
//
// `argv` mirrors scripts/meta-sync.mjs's own CLI convention: an empty
// array (or fewer than 2 elements) means "default trailing 7 days";
// exactly [since, until] means an explicit backfill range. Validation
// happens here, per account, exactly as it always has — an invalid
// explicit range fails each account independently (the caller's
// per-account try/catch records it as that account's own error) rather
// than crashing the whole run.
export function resolveDateRangeForAccount(argv: string[], accountTimezone: string): DateRange {
  if (argv.length >= 2) {
    const [since, until] = argv;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      throw new Error(
        `Invalid explicit date range "${since}".."${until}" — expected YYYY-MM-DD YYYY-MM-DD`
      );
    }
    return { since, until, mode: "explicit" };
  }
  // Default: trailing 7 completed days ending yesterday, in this
  // account's own Meta-reported timezone — never a hardcoded timezone,
  // and never today (an "open" local day whose numbers are still moving).
  const today = todayInTimezone(accountTimezone);
  const until = addDays(today, -1);
  const since = addDays(until, -6); // 7 days inclusive: until-6 .. until
  return { since, until, mode: "default-trailing-7d" };
}

// ------------------------------------------------------------------
// Money conversion — integer agorot, matching the CRM convention
// (see lib/crm/format.ts / app actions: Math.round(amountNis * 100)).
// Meta returns spend as a decimal string, e.g. "20.99".
// ------------------------------------------------------------------

export function ilsToAgorot(decimalSpendString: string | number): number {
  const n = Number(decimalSpendString);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Unexpected Meta spend value: ${JSON.stringify(decimalSpendString)}`);
  }
  return Math.round(n * 100);
}

// ------------------------------------------------------------------
// Meta Marketing API
// ------------------------------------------------------------------

type MetaErrorShape = { type?: string; code?: number | string; message?: string };
type MetaGraphResponse<T> = T & { error?: MetaErrorShape };

async function metaGet<T>(
  pathPart: string,
  params: Record<string, string | number>,
  token: string
): Promise<MetaGraphResponse<T>> {
  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}${pathPart}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json: MetaGraphResponse<T> = await res.json();
  if (!res.ok || json.error) {
    const err: MetaErrorShape = json.error ?? {};
    const e = new Error(
      `Meta API error (HTTP ${res.status}): ${err.type ?? "unknown"} ${err.code ?? ""} — ${
        err.message ?? "no message"
      }`
    );
    throw e;
  }
  return json;
}

type AccountMeta = { id: string; name: string | null; currency: string; timezone_name: string | null };

async function fetchAccountMeta(adAccountId: string, token: string): Promise<AccountMeta> {
  return metaGet<AccountMeta>(
    `/${adAccountId}`,
    { fields: "id,name,currency,timezone_name,account_status" },
    token
  );
}

type InsightRow = {
  campaign_id: string | number;
  campaign_name?: string | null;
  spend?: string;
  impressions?: string | number;
  reach?: string | number;
  clicks?: string | number;
  date_start: string;
  date_stop: string;
};

// Fetches all pages of campaign-level, daily Insights for [since, until].
async function fetchCampaignDailyInsights({
  adAccountId,
  token,
  since,
  until,
}: {
  adAccountId: string;
  token: string;
  since: string;
  until: string;
}): Promise<InsightRow[]> {
  type InsightsPage = { data?: InsightRow[]; paging?: { next?: string }; error?: MetaErrorShape };

  const rows: InsightRow[] = [];
  let json = await metaGet<InsightsPage>(
    `/${adAccountId}/insights`,
    {
      level: "campaign",
      time_increment: 1,
      fields: "campaign_id,campaign_name,spend,impressions,reach,clicks,date_start,date_stop",
      time_range: JSON.stringify({ since, until }),
      limit: 200,
    },
    token
  );
  rows.push(...(json.data ?? []));

  // Handle pagination.
  let pageCount = 1;
  while (json.paging?.next) {
    const nextUrl = new URL(json.paging.next);
    const res = await fetch(nextUrl, { headers: { Authorization: `Bearer ${token}` } });
    json = (await res.json()) as InsightsPage;
    if (json.error) {
      throw new Error(
        `Meta API pagination error: ${json.error.type ?? ""} ${json.error.code ?? ""} — ${
          json.error.message ?? ""
        }`
      );
    }
    rows.push(...(json.data ?? []));
    pageCount += 1;
    if (pageCount > 50) throw new Error("Meta API pagination exceeded 50 pages — aborting.");
  }

  return rows;
}

// ------------------------------------------------------------------
// Per-account pipeline
// ------------------------------------------------------------------

export type AccountSyncSuccess = {
  accountId: string;
  success: true;
  accountName: string | null;
  timezone: string;
  dateRange: DateRange;
  metaInsightRowsReceived: number;
  upsertedRowCount: number;
  totalSpendMinor: number;
};

export type AccountSyncFailure = {
  accountId: string;
  success: false;
  error: string;
};

export type AccountSyncResult = AccountSyncSuccess | AccountSyncFailure;

async function syncOneAccount({
  accountId,
  token,
  argv,
  supabase,
}: {
  accountId: string;
  token: string;
  argv: string[];
  supabase: SupabaseClient;
}): Promise<AccountSyncSuccess> {
  const accountMeta = await fetchAccountMeta(accountId, token);
  const timezone = accountMeta.timezone_name;
  if (!timezone) {
    throw new Error(
      `Meta did not return a timezone_name for ${accountId} — cannot compute a safe default window.`
    );
  }

  const { since, until, mode } = resolveDateRangeForAccount(argv, timezone);

  console.log(
    JSON.stringify({
      step: "account_start",
      accountId,
      accountName: accountMeta.name,
      timezone,
      dateRange: { since, until, mode },
    })
  );

  const insightRows = await fetchCampaignDailyInsights({ adAccountId: accountId, token, since, until });

  console.log(
    JSON.stringify({ step: "meta_fetch_complete", accountId, rowsReceived: insightRows.length })
  );

  const dbRows = insightRows.map((r) => ({
    meta_ad_account_id: accountId,
    campaign_id: String(r.campaign_id),
    campaign_name: r.campaign_name ?? null,
    metric_date: r.date_start, // time_increment=1 => date_start === date_stop
    spend_minor: ilsToAgorot(r.spend ?? "0"),
    impressions: Number(r.impressions ?? 0),
    reach: Number(r.reach ?? 0),
    clicks: Number(r.clicks ?? 0),
  }));

  let upsertedCount = 0;
  if (dbRows.length > 0) {
    const { data, error } = await supabase
      .from("meta_campaign_daily_metrics")
      .upsert(dbRows, { onConflict: "meta_ad_account_id,campaign_id,metric_date" })
      .select("id");
    if (error) throw new Error(`Supabase upsert failed for ${accountId}: ${error.message}`);
    upsertedCount = data?.length ?? 0;
  }

  const totalSpendMinor = dbRows.reduce((s, r) => s + r.spend_minor, 0);

  return {
    accountId,
    success: true,
    accountName: accountMeta.name,
    timezone,
    dateRange: { since, until, mode },
    metaInsightRowsReceived: insightRows.length,
    upsertedRowCount: upsertedCount,
    totalSpendMinor,
  };
}

// ------------------------------------------------------------------
// Top-level orchestration — one run across every configured account.
// ------------------------------------------------------------------

export type MetaCampaignSyncResult = {
  success: boolean;
  accounts: AccountSyncResult[];
  combinedTotalSpendMinor: number;
};

export async function runMetaCampaignSync({
  supabase,
  metaToken,
  accountIds,
  argv = [],
}: {
  supabase: SupabaseClient;
  metaToken: string;
  accountIds: string[];
  argv?: string[];
}): Promise<MetaCampaignSyncResult> {
  console.log(JSON.stringify({ step: "start", configuredAccounts: accountIds }));

  const results: AccountSyncResult[] = [];
  for (const accountId of accountIds) {
    try {
      const result = await syncOneAccount({ accountId, token: metaToken, argv, supabase });
      results.push(result);
    } catch (err) {
      results.push({ accountId, success: false, error: String((err as Error).message ?? err) });
    }
  }

  const anyFailed = results.some((r) => !r.success);
  const combinedTotalSpendMinor = results.reduce(
    (s, r) => s + (r.success ? r.totalSpendMinor : 0),
    0
  );

  return { success: !anyFailed, accounts: results, combinedTotalSpendMinor };
}
