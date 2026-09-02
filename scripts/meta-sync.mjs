#!/usr/bin/env node
// GAL CRM — Meta Marketing API daily campaign sync (Phase 1: persistence,
// now multi-account).
//
// TRUSTED SERVER-ONLY SCRIPT. Never import this from app code that runs
// in the browser. Reads META_ACCESS_TOKEN and SUPABASE_SERVICE_ROLE_KEY
// from the server environment only — neither is ever logged, printed,
// or included in any error message this script produces.
//
// What it does, for EACH configured ad account independently:
//   1. Fetches the account's own metadata from Meta first — in
//      particular its reporting timezone_name. Different ad accounts
//      can have different timezones (verified live: one GAL ad account
//      is Asia/Jerusalem, another is America/Los_Angeles) — this script
//      never assumes a single shared timezone.
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
// pipeline is independently try/caught, and the script exits non-zero
// only if at least one account failed (see the final summary object).
//
// What it deliberately does NOT do: create/modify any Meta object,
// touch any other Supabase table, or run on a schedule (no cron here).
//
// Usage:
//   node scripts/meta-sync.mjs                  # default: trailing 7
//                                                 completed local days per
//                                                 account, each in its own
//                                                 Meta-reported timezone
//   node scripts/meta-sync.mjs 2026-08-20 2026-08-26   # explicit backfill
//                                                 range, applied to every
//                                                 configured account
//
// Required env (server-only; see .env.local — never NEXT_PUBLIC_*):
//   META_AD_ACCOUNT_IDS   comma-separated, e.g. "act_123,act_456"
//                         (falls back to the older singular
//                         META_AD_ACCOUNT_ID if _IDS isn't set, for
//                         backward compatibility with a single account)
//   META_ACCESS_TOKEN
//   NEXT_PUBLIC_SUPABASE_URL        (reused — it's a URL, not a secret)
//   SUPABASE_SERVICE_ROLE_KEY       (server-only; NOT the anon key)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, "..", ".env.local");

function loadEnvLocal() {
  if (!fs.existsSync(ENV_PATH)) return;
  const text = fs.readFileSync(ENV_PATH, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    // Don't clobber real environment variables already set (e.g. in CI).
    if (process.env[key] === undefined) process.env[key] = rawVal.trim();
  }
}
loadEnvLocal();

const META_API_VERSION = "v21.0";

// ------------------------------------------------------------------
// Multi-account config
// ------------------------------------------------------------------

function normalizeAccountId(raw) {
  const trimmed = raw.trim();
  return trimmed.startsWith("act_") ? trimmed : `act_${trimmed}`;
}

function resolveConfiguredAccountIds() {
  const plural = process.env.META_AD_ACCOUNT_IDS;
  if (plural && plural.trim().length > 0) {
    return plural
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(normalizeAccountId);
  }
  // Backward compatibility: single-account env var from before
  // multi-account support existed.
  const singular = process.env.META_AD_ACCOUNT_ID;
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
function todayInTimezone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(isoDate, days) {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// argv-supplied explicit range applies identically to every account (the
// smallest safe design for manual/backfill runs — see the task's own
// "explicit manual backfill ranges should still be supported" note).
// Only the DEFAULT (no explicit range) path varies per account, since
// that's the one case where "yesterday" genuinely differs by timezone.
function resolveDateRangeForAccount(argv, accountTimezone) {
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

function ilsToAgorot(decimalSpendString) {
  const n = Number(decimalSpendString);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Unexpected Meta spend value: ${JSON.stringify(decimalSpendString)}`);
  }
  return Math.round(n * 100);
}

// ------------------------------------------------------------------
// Meta Marketing API
// ------------------------------------------------------------------

async function metaGet(pathPart, params, token) {
  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}${pathPart}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  if (!res.ok || json.error) {
    const err = json.error ?? {};
    const e = new Error(
      `Meta API error (HTTP ${res.status}): ${err.type ?? "unknown"} ${err.code ?? ""} — ${
        err.message ?? "no message"
      }`
    );
    e.metaError = err;
    throw e;
  }
  return json;
}

async function fetchAccountMeta(adAccountId, token) {
  const json = await metaGet(
    `/${adAccountId}`,
    { fields: "id,name,currency,timezone_name,account_status" },
    token
  );
  return json;
}

// Fetches all pages of campaign-level, daily Insights for [since, until].
async function fetchCampaignDailyInsights({ adAccountId, token, since, until }) {
  const rows = [];
  let json = await metaGet(
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
    json = await res.json();
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

async function syncOneAccount({ accountId, token, argv, supabase }) {
  const accountMeta = await fetchAccountMeta(accountId, token);
  const timezone = accountMeta.timezone_name;
  if (!timezone) {
    throw new Error(`Meta did not return a timezone_name for ${accountId} — cannot compute a safe default window.`);
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
    accountName: accountMeta.name,
    timezone,
    dateRange: { since, until, mode },
    metaInsightRowsReceived: insightRows.length,
    upsertedRowCount: upsertedCount,
    totalSpendMinor,
  };
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);

  const metaToken = process.env.META_ACCESS_TOKEN;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const accountIds = resolveConfiguredAccountIds();

  const missing = [];
  if (accountIds.length === 0) missing.push("META_AD_ACCOUNT_IDS (or META_AD_ACCOUNT_ID)");
  if (!metaToken) missing.push("META_ACCESS_TOKEN");
  if (!supabaseUrl) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length > 0) {
    console.error(
      JSON.stringify(
        {
          success: false,
          error: "missing_env",
          missingVariables: missing,
          hint: "Add the missing variable NAME(s) above to .env.local. Never paste secret values in chat.",
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  console.log(JSON.stringify({ step: "start", configuredAccounts: accountIds }));

  const results = [];
  for (const accountId of accountIds) {
    try {
      const result = await syncOneAccount({ accountId, token: metaToken, argv, supabase });
      results.push({ ...result, success: true });
    } catch (err) {
      results.push({ accountId, success: false, error: String(err.message ?? err) });
    }
  }

  const anyFailed = results.some((r) => !r.success);
  const combinedTotalSpendMinor = results.reduce((s, r) => s + (r.totalSpendMinor ?? 0), 0);

  console.log(
    JSON.stringify(
      {
        success: !anyFailed,
        accounts: results,
        combinedTotalSpendMinor,
      },
      null,
      2
    )
  );

  if (anyFailed) process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({ success: false, step: "unhandled", error: String(err.message ?? err) }));
  process.exit(1);
});
