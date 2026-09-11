import { computeSyncFreshness } from "./sync-freshness.ts";
import type { MetaSyncStateRepo } from "./sync-state-repo.ts";

// Orchestrates "should a Meta campaign-spend sync run right now, and if
// so, run it exactly once" — the freshness check (10-minute TTL, via
// lib/meta/sync-freshness.ts) plus the server-side concurrency lock
// (lib/meta/sync-state-repo.ts's atomic claim) plus outcome bookkeeping,
// all in one small, dependency-injected function. `repo` and `runSync`
// are injected (same style as lib/meta/ingest.ts::processOneLeadgenId)
// so this is fully unit-testable — including TRUE concurrent-call
// behavior — against an in-memory fake (lib/meta/sync-fakes.ts,
// lib/meta/sync-orchestrator.test.ts) without a live database or a real
// Meta API call.
//
// This module never imports the service-role admin client itself — its
// only two real callers (app/api/meta/sync/trigger/route.ts, for both the
// Dashboard's automatic background trigger and the manual "רענון עכשיו"
// button) construct the admin client and the real runSync/repo and pass
// them in. Never called from a Server Component directly.

export type TriggerReason = "fresh" | "already_running" | "success" | "failed";

export type TriggerOutcome = {
  triggered: boolean;
  reason: TriggerReason;
};

function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Defense in depth: nothing in the real Meta/Supabase error paths this
  // wraps is expected to ever include a token, but redact the shape
  // anyway before this ever reaches storage or logs (see
  // meta_sync_state.last_error's own column comment).
  const redacted = raw.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
}

export async function triggerMetaSyncIfNeeded({
  repo,
  runSync,
  force = false,
  now = new Date(),
}: {
  repo: MetaSyncStateRepo;
  /** Does the actual work (the real caller binds this to
   *  runMetaCampaignSync from lib/meta/campaign-sync.ts). Any error it
   *  throws is caught here — a Meta outage must never propagate past
   *  this function, so the Dashboard can never be broken by it. */
  runSync: () => Promise<unknown>;
  /** Bypasses the 10-minute freshness TTL (the manual "רענון עכשיו"
   *  button) — still fully subject to the concurrency claim below. */
  force?: boolean;
  now?: Date;
}): Promise<TriggerOutcome> {
  if (!force) {
    const state = await repo.getState();
    const freshness = computeSyncFreshness(
      state ? { status: state.status, lastSuccessAt: state.lastSuccessAt } : null,
      now
    );
    if (!freshness.isStale) {
      return { triggered: false, reason: "fresh" };
    }
  }

  const claimed = await repo.claimRun(now);
  if (!claimed) {
    // Someone else (another tab, another user, a racing request) is
    // already syncing — never start a second one. The caller keeps
    // using cached data.
    return { triggered: false, reason: "already_running" };
  }

  try {
    await runSync();
    await repo.markSuccess();
    return { triggered: true, reason: "success" };
  } catch (err) {
    const sanitized = sanitizeErrorMessage(err);
    console.error(JSON.stringify({ step: "meta_sync_failed", error: sanitized }));
    try {
      await repo.markFailure(sanitized);
    } catch (markErr) {
      console.error(
        JSON.stringify({
          step: "meta_sync_mark_failure_failed",
          error: sanitizeErrorMessage(markErr),
        })
      );
    }
    return { triggered: true, reason: "failed" };
  }
}
