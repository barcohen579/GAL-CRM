#!/usr/bin/env node
// GAL CRM — Meta Marketing API daily campaign sync CLI (Phase 1:
// persistence, multi-account).
//
// TRUSTED SERVER-ONLY SCRIPT. Never import this from app code that runs
// in the browser. Reads META_ACCESS_TOKEN and SUPABASE_SERVICE_ROLE_KEY
// from the server environment only — neither is ever logged, printed,
// or included in any error message this script produces.
//
// This is now a thin CLI wrapper: all the actual sync logic (multi-
// account loop, per-account timezone-aware date window, Meta Insights
// fetch, upsert) lives in lib/meta/campaign-sync.ts, so this manual/
// backfill entrypoint and the automatic Dashboard-triggered sync
// (app/api/meta/sync/trigger/route.ts, via lib/meta/sync-orchestrator.ts)
// run the exact same production-tested code — never two independent
// Meta integrations.
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
import { resolveConfiguredAccountIds, runMetaCampaignSync } from "../lib/meta/campaign-sync.ts";

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

async function main() {
  const argv = process.argv.slice(2);

  const metaToken = process.env.META_ACCESS_TOKEN;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const accountIds = resolveConfiguredAccountIds(process.env);

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

  const result = await runMetaCampaignSync({ supabase, metaToken, accountIds, argv });

  console.log(JSON.stringify(result, null, 2));

  if (!result.success) process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({ success: false, step: "unhandled", error: String(err.message ?? err) }));
  process.exit(1);
});
