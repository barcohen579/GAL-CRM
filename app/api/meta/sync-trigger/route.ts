// GAL CRM — Meta campaign-spend sync trigger.
//
// The ONLY route that actually runs a Meta sync. Reached two ways:
//   1. Automatically, right after the Dashboard finishes rendering stale
//      data (app/(app)/dashboard/page.tsx, via `after()`) — authenticated
//      as a trusted internal caller with the same CRON_SECRET already
//      used for every app/api/cron/* route (see lib/cron/auth.ts). This
//      keeps the service-role admin client confined to a Route Handler,
//      never imported by that Server Component.
//   2. Manually, by the "רענון עכשיו" button (components/dashboard/
//      meta-freshness-indicator.tsx) — authenticated as a normal CRM
//      user session (getCrmUser()), with `force: true` to bypass the
//      10-minute freshness TTL.
//
// Either way, the actual work is the SAME production-tested code
// (lib/meta/campaign-sync.ts::runMetaCampaignSync, also used by
// scripts/meta-sync.mjs) behind the SAME server-side concurrency lock
// (lib/meta/sync-orchestrator.ts::triggerMetaSyncIfNeeded +
// lib/meta/sync-state-repo.ts) — never two independent Meta integrations,
// never a duplicate sync from two simultaneous requests.
//
// Never leaks account ids, tokens, or raw Meta/Postgres error text in the
// response — only a coarse {ok, triggered, reason}. Diagnostic detail
// (already sanitized by the orchestrator) goes to server-side logs and
// meta_sync_state.last_error only.
import { createAdminClient } from "../../../../lib/supabase/admin.ts";
import { createClient } from "../../../../lib/supabase/server.ts";
import { getCronSecret } from "../../../../lib/cron/env.ts";
import { verifyCronAuthHeader } from "../../../../lib/cron/auth.ts";
import { getMetaAccessToken, getInstagramBusinessAccountId } from "../../../../lib/meta/env.ts";
import { resolveConfiguredAccountIds, runMetaCampaignSync } from "../../../../lib/meta/campaign-sync.ts";
import { syncInstagramFollowerSnapshot } from "../../../../lib/meta/instagram-follower-sync.ts";
import { createSupabaseMetaSyncStateRepo } from "../../../../lib/meta/sync-state-repo.ts";
import { triggerMetaSyncIfNeeded } from "../../../../lib/meta/sync-orchestrator.ts";
import { zonedParts, ISRAEL_TIME_ZONE } from "../../../../lib/crm/timezone.ts";

export const runtime = "nodejs";
// Headroom for two accounts' worth of Meta Insights calls + upserts —
// same "generous over expected sub-minute runtime" reasoning as the
// other cron routes.
export const maxDuration = 60;

async function isAuthorizedInternalCall(request: Request): Promise<boolean> {
  let cronSecret: string;
  try {
    cronSecret = getCronSecret();
  } catch {
    return false; // CRON_SECRET not configured -- this auth path is unavailable.
  }
  return verifyCronAuthHeader(request.headers.get("authorization"), cronSecret);
}

async function isAuthorizedCrmSession(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;
    const { data: appUser } = await supabase
      .from("app_users")
      .select("id, is_active")
      .eq("auth_user_id", user.id)
      .maybeSingle();
    return Boolean(appUser?.is_active);
  } catch {
    return false; // fail closed, same convention as getCrmUser().
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorized =
    (await isAuthorizedInternalCall(request)) || (await isAuthorizedCrmSession());
  if (!authorized) {
    return new Response("Unauthorized.", { status: 401 });
  }

  let force = false;
  try {
    const body = await request.json();
    force = body?.force === true;
  } catch {
    // No/invalid JSON body -- default to force:false (the automatic
    // background trigger sends no body at all in practice; treat that
    // the same as an explicit {force:false}).
  }

  let accountIds: string[];
  let metaToken: string;
  try {
    accountIds = resolveConfiguredAccountIds();
    metaToken = getMetaAccessToken();
  } catch (err) {
    console.error(
      JSON.stringify({ step: "meta_sync_trigger_misconfigured", error: String((err as Error).message ?? err) })
    );
    return Response.json({ ok: false, triggered: false, reason: "not_configured" }, { status: 500 });
  }

  const admin = createAdminClient();
  const repo = createSupabaseMetaSyncStateRepo(admin);
  const runSync = async () => {
    const result = await runMetaCampaignSync({ supabase: admin, metaToken, accountIds });
    if (!result.success) {
      // At least one account failed -- surface as a failed attempt so
      // last_success_at is NOT advanced, even though some other
      // account(s) may have synced fine (each account's own upsert
      // already committed independently, and is idempotent to retry).
      const failedAccounts = result.accounts.filter((a) => !a.success);
      throw new Error(
        `Meta sync partially failed for ${failedAccounts.length}/${result.accounts.length} account(s)`
      );
    }

    // Instagram follower snapshot — best-effort enrichment, never lets a
    // failure here turn a successful campaign-spend sync into a
    // reported failure (same "enrichment, never blocking" reasoning as
    // the campaign objective/status metadata fetch). No-ops entirely
    // when INSTAGRAM_BUSINESS_ACCOUNT_ID isn't configured yet.
    const igUserId = getInstagramBusinessAccountId();
    if (igUserId) {
      try {
        const todayDateKey = zonedParts(new Date(), ISRAEL_TIME_ZONE).dateKey;
        await syncInstagramFollowerSnapshot({ supabase: admin, metaToken, igUserId, todayDateKey });
      } catch (err) {
        console.error(
          JSON.stringify({
            step: "instagram_follower_snapshot_failed",
            error: String((err as Error).message ?? err),
          })
        );
      }
    }

    return result;
  };

  const outcome = await triggerMetaSyncIfNeeded({ repo, runSync, force });

  console.log(
    JSON.stringify({ step: "meta_sync_trigger_completed", triggered: outcome.triggered, reason: outcome.reason })
  );

  return Response.json({ ok: true, triggered: outcome.triggered, reason: outcome.reason });
}
