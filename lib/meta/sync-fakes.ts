// In-memory fake implementing MetaSyncStateRepo for tests. No network,
// no database — used only by lib/meta/sync-orchestrator.test.ts. Mirrors
// the real table's atomic-claim semantics closely enough (see claimRun
// below) that a true `Promise.all` concurrency test against this fake is
// meaningful evidence, not a tautology — same philosophy as
// lib/meta/fakes.ts for the lead-ingestion pipeline.

import type { MetaSyncStateRepo, MetaSyncStateRow } from "./sync-state-repo.ts";
import { META_SYNC_STALE_LOCK_MS } from "./sync-state-repo.ts";
import type { MetaSyncStatus } from "./sync-freshness.ts";

export type FakeSyncState = {
  status: MetaSyncStatus;
  lastAttemptStartedAtMs: number | null;
  lastAttemptFinishedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
};

export function createFakeSyncState(overrides: Partial<FakeSyncState> = {}): FakeSyncState {
  return {
    status: "idle",
    lastAttemptStartedAtMs: null,
    lastAttemptFinishedAt: null,
    lastSuccessAt: null,
    lastError: null,
    ...overrides,
  };
}

function toRow(state: FakeSyncState): MetaSyncStateRow {
  return {
    source: "META",
    status: state.status,
    lastAttemptStartedAt:
      state.lastAttemptStartedAtMs === null ? null : new Date(state.lastAttemptStartedAtMs).toISOString(),
    lastAttemptFinishedAt: state.lastAttemptFinishedAt,
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError,
  };
}

export function createFakeMetaSyncStateRepo(state: FakeSyncState): MetaSyncStateRepo {
  return {
    async getState() {
      return toRow(state);
    },

    async claimRun(now = new Date()) {
      // Mirrors the real atomic `UPDATE ... WHERE status <> 'running' OR
      // last_attempt_started_at < staleThreshold`. This method body runs
      // synchronously (no `await` inside) — under Node's single-threaded
      // execution that's exactly what makes it atomic, matching one SQL
      // UPDATE statement: two truly-concurrent callers can both reach
      // this function, but only the first to actually execute the body
      // observes/sets `status`, and the second sees its own change.
      const isStaleRunning =
        state.status === "running" &&
        state.lastAttemptStartedAtMs !== null &&
        now.getTime() - state.lastAttemptStartedAtMs >= META_SYNC_STALE_LOCK_MS;
      if (state.status === "running" && !isStaleRunning) {
        return null;
      }
      state.status = "running";
      state.lastAttemptStartedAtMs = now.getTime();
      return toRow(state);
    },

    async markSuccess(now = new Date()) {
      state.status = "success";
      state.lastAttemptFinishedAt = now.toISOString();
      state.lastSuccessAt = now.toISOString();
      state.lastError = null;
    },

    async markFailure(sanitizedErrorMessage, now = new Date()) {
      state.status = "failed";
      state.lastAttemptFinishedAt = now.toISOString();
      state.lastError = sanitizedErrorMessage;
      // last_success_at deliberately untouched — a failed attempt must
      // never make the data look fresher than it is.
    },
  };
}

// Test-only helper: backdates the fake's internal "claimed at" clock so
// the stale-running reclaim can be exercised deterministically, mirroring
// lib/meta/fakes.ts::backdateIngestionRow.
export function backdateSyncAttempt(state: FakeSyncState, ageMs: number): void {
  state.lastAttemptStartedAtMs = Date.now() - ageMs;
}
