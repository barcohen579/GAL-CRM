import { test } from "node:test";
import assert from "node:assert/strict";
import { triggerMetaSyncIfNeeded } from "./sync-orchestrator.ts";
import {
  backdateSyncAttempt,
  createFakeMetaSyncStateRepo,
  createFakeSyncState,
} from "./sync-fakes.ts";
import { META_SYNC_STALE_LOCK_MS } from "./sync-state-repo.ts";
import { META_SYNC_FRESHNESS_TTL_MS } from "./sync-freshness.ts";

function countingRunSync(result: { calls: number } = { calls: 0 }) {
  const fn = async () => {
    result.calls += 1;
  };
  return { fn, result };
}

test("orchestrator: no successful sync yet -> a sync is requested (runSync called)", async () => {
  const repo = createFakeMetaSyncStateRepo(createFakeSyncState());
  const { fn, result } = countingRunSync();

  const outcome = await triggerMetaSyncIfNeeded({ repo, runSync: fn });

  assert.equal(outcome.triggered, true);
  assert.equal(outcome.reason, "success");
  assert.equal(result.calls, 1);
});

test("orchestrator: last successful sync >10 minutes ago -> a sync is requested", async () => {
  const state = createFakeSyncState({
    status: "success",
    lastSuccessAt: new Date(Date.now() - META_SYNC_FRESHNESS_TTL_MS - 60_000).toISOString(),
  });
  const repo = createFakeMetaSyncStateRepo(state);
  const { fn, result } = countingRunSync();

  const outcome = await triggerMetaSyncIfNeeded({ repo, runSync: fn });

  assert.equal(outcome.triggered, true);
  assert.equal(result.calls, 1);
});

test("orchestrator: last successful sync <10 minutes ago -> NO sync requested, runSync never called", async () => {
  const state = createFakeSyncState({
    status: "success",
    lastSuccessAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
  });
  const repo = createFakeMetaSyncStateRepo(state);
  const { fn, result } = countingRunSync();

  const outcome = await triggerMetaSyncIfNeeded({ repo, runSync: fn });

  assert.equal(outcome.triggered, false);
  assert.equal(outcome.reason, "fresh");
  assert.equal(result.calls, 0, "a fresh sync must never call runSync at all");
});

test("orchestrator: a successful sync updates the freshness timestamp", async () => {
  const repo = createFakeMetaSyncStateRepo(createFakeSyncState());
  await triggerMetaSyncIfNeeded({ repo, runSync: async () => {} });

  const state = await repo.getState();
  assert.ok(state?.lastSuccessAt, "last_success_at should be set after a successful run");
  assert.equal(state?.status, "success");
});

test("orchestrator: a failed sync does NOT update last_success_at", async () => {
  const previousSuccessAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const state = createFakeSyncState({ status: "success", lastSuccessAt: previousSuccessAt });
  const repo = createFakeMetaSyncStateRepo(state);

  // Force the run even though it's fresh, to exercise the failure path
  // deterministically without waiting on the TTL.
  const outcome = await triggerMetaSyncIfNeeded({
    repo,
    runSync: async () => {
      throw new Error("Meta API error (HTTP 500): server_error — temporary outage");
    },
    force: true,
  });

  assert.equal(outcome.triggered, true);
  assert.equal(outcome.reason, "failed");

  const after = await repo.getState();
  assert.equal(after?.status, "failed");
  assert.equal(after?.lastSuccessAt, previousSuccessAt, "a failed attempt must never advance last_success_at");
  assert.ok(after?.lastError, "a sanitized error message should be recorded");
});

test("orchestrator: two simultaneous requests cannot start duplicate syncs (true concurrency)", async () => {
  const repo = createFakeMetaSyncStateRepo(createFakeSyncState());
  const shared = { calls: 0 };
  const { fn } = countingRunSync(shared);

  const [a, b] = await Promise.all([
    triggerMetaSyncIfNeeded({ repo, runSync: fn }),
    triggerMetaSyncIfNeeded({ repo, runSync: fn }),
  ]);

  assert.equal(shared.calls, 1, "runSync must be invoked exactly once across both concurrent requests");
  const reasons = [a.reason, b.reason].sort();
  assert.deepEqual(reasons, ["already_running", "success"]);
});

test("orchestrator: manual force:true bypasses the freshness TTL but still respects the lock", async () => {
  const state = createFakeSyncState({
    status: "success",
    lastSuccessAt: new Date(Date.now() - 1000).toISOString(), // 1 second ago — very fresh
  });
  const repo = createFakeMetaSyncStateRepo(state);
  const { fn, result } = countingRunSync();

  const outcome = await triggerMetaSyncIfNeeded({ repo, runSync: fn, force: true });

  assert.equal(outcome.triggered, true);
  assert.equal(result.calls, 1, "force:true must trigger a sync even though the data is fresh");

  // ...but force:true against an ALREADY-RUNNING (not stale) lock still
  // does not start a second sync.
  const runningState = createFakeSyncState({ status: "running", lastAttemptStartedAtMs: Date.now() });
  const runningRepo = createFakeMetaSyncStateRepo(runningState);
  const second = countingRunSync();
  const forcedOutcome = await triggerMetaSyncIfNeeded({ repo: runningRepo, runSync: second.fn, force: true });
  assert.equal(forcedOutcome.triggered, false);
  assert.equal(forcedOutcome.reason, "already_running");
  assert.equal(second.result.calls, 0);
});

test("orchestrator: a stale (crashed) running lock becomes reclaimable", async () => {
  const state = createFakeSyncState({ status: "running", lastAttemptStartedAtMs: Date.now() });
  backdateSyncAttempt(state, META_SYNC_STALE_LOCK_MS + 1000);
  const repo = createFakeMetaSyncStateRepo(state);
  const { fn, result } = countingRunSync();

  const outcome = await triggerMetaSyncIfNeeded({ repo, runSync: fn, force: true });

  assert.equal(outcome.triggered, true);
  assert.equal(result.calls, 1);
});

test("orchestrator: a throwing runSync never propagates out (Dashboard stays usable on a Meta outage)", async () => {
  const repo = createFakeMetaSyncStateRepo(createFakeSyncState());

  await assert.doesNotReject(async () => {
    const outcome = await triggerMetaSyncIfNeeded({
      repo,
      runSync: async () => {
        throw new Error("network error: ETIMEDOUT contacting graph.facebook.com");
      },
    });
    assert.equal(outcome.reason, "failed");
  });
});

test("orchestrator: a sanitized error never contains a raw bearer token", async () => {
  const repo = createFakeMetaSyncStateRepo(createFakeSyncState());

  await triggerMetaSyncIfNeeded({
    repo,
    runSync: async () => {
      throw new Error("Meta API error: unauthorized while using Bearer EAAG-super-secret-token-value");
    },
  });

  const state = await repo.getState();
  assert.ok(state?.lastError);
  assert.ok(!state!.lastError!.includes("super-secret-token-value"), "raw token must never be stored");
});
