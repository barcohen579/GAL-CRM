// Pure freshness computation for the Meta campaign-spend sync — zero
// imports beyond types, so this is safe to import directly from the
// Dashboard Server Component (app/(app)/dashboard/page.tsx) without
// pulling in the service-role admin client or any Meta/Supabase I/O.
// See lib/meta/sync-state-repo.ts for the persisted state this reads,
// and lib/meta/sync-orchestrator.ts for the module that actually acts on
// it (imported only by Route Handlers, never by a Server Component).
//
// Freshness is deliberately ONLY ever derived from last_success_at —
// never from the latest metric_date present in meta_campaign_daily_metrics
// or from whether today's row exists, because Meta can still revise a
// day's already-synced spend without a new sync having run (see that
// table's own migration comment).

export type MetaSyncStatus = "idle" | "running" | "success" | "failed";

export const META_SYNC_FRESHNESS_TTL_MS = 10 * 60 * 1000;

export type MetaSyncStateSnapshot = {
  status: MetaSyncStatus;
  lastSuccessAt: string | null;
};

export type MetaSyncFreshness = {
  status: MetaSyncStatus;
  lastSuccessAt: string | null;
  /** True when a sync should be (re)triggered: never synced, or the last
   *  success is >= META_SYNC_FRESHNESS_TTL_MS old. Independent of
   *  `status === "running"` — a currently-running sync is handled by the
   *  server-side claim/lock (lib/meta/sync-state-repo.ts), not by this
   *  flag. */
  isStale: boolean;
};

export function computeSyncFreshness(
  state: MetaSyncStateSnapshot | null,
  now: Date = new Date()
): MetaSyncFreshness {
  if (!state || !state.lastSuccessAt) {
    return { status: state?.status ?? "idle", lastSuccessAt: null, isStale: true };
  }
  const ageMs = now.getTime() - new Date(state.lastSuccessAt).getTime();
  return {
    status: state.status,
    lastSuccessAt: state.lastSuccessAt,
    isStale: ageMs >= META_SYNC_FRESHNESS_TTL_MS,
  };
}
