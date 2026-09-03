#!/usr/bin/env node
// GAL CRM — manual/trusted reprocessing for a stuck Meta lead ingestion
// row (status PENDING or FAILED). TRUSTED SERVER-ONLY SCRIPT — reads
// META_ACCESS_TOKEN and SUPABASE_SERVICE_ROLE_KEY from the server
// environment only (see scripts/meta-sync.mjs for the established
// precedent of this exact env-loading pattern). Never logs field_data,
// phone, or email — only ids and status (see lib/meta/ingest.ts).
//
// This is the durable backstop for the rare case where Meta's own
// webhook delivery retries are exhausted before a transient failure
// resolves — see the design-decision comment at the top of
// lib/meta/ingest.ts. It shares that exact module's processOneLeadgenId
// with the webhook route, so "reprocess" and "process for the first
// time" are the same code path — no separate reimplementation to drift.
//
// Idempotent: safe to run against an already-PROCESSED/DUPLICATE_IGNORED
// row (no-ops, reports "duplicate"); safe to re-run after a failure.
//
// Usage:
//   node scripts/meta-reprocess-lead.ts <leadgen_id>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminClient } from "../lib/supabase/admin.ts";
import { createSupabaseMetaIngestionRepo } from "../lib/meta/repo.ts";
import { processOneLeadgenId } from "../lib/meta/ingest.ts";
import { makePageAccessTokenDeriver, fetchLeadByLeadgenId } from "../lib/meta/graph.ts";
import { getMetaAccessToken } from "../lib/meta/env.ts";

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
  const leadgenId = process.argv[2];
  if (!leadgenId) {
    console.error(
      JSON.stringify({
        success: false,
        error: "usage",
        hint: "node scripts/meta-reprocess-lead.ts <leadgen_id>",
      })
    );
    process.exit(1);
  }

  const missing: string[] = [];
  if (!process.env.META_ACCESS_TOKEN) missing.push("META_ACCESS_TOKEN");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
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

  const supabase = createAdminClient();
  const repo = createSupabaseMetaIngestionRepo(supabase);
  const derivePageAccessToken = makePageAccessTokenDeriver(getMetaAccessToken());

  console.log(JSON.stringify({ step: "start", leadgenId }));

  const outcome = await processOneLeadgenId(repo, leadgenId, null, {
    derivePageAccessToken,
    fetchLead: fetchLeadByLeadgenId,
  });

  console.log(JSON.stringify({ success: outcome.outcome !== "failed", outcome }, null, 2));
  if (outcome.outcome === "failed") process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({ success: false, step: "unhandled", error: String(err?.message ?? err) }));
  process.exit(1);
});
