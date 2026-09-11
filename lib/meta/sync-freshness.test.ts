import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSyncFreshness, META_SYNC_FRESHNESS_TTL_MS } from "./sync-freshness.ts";

const NOW = new Date("2026-09-11T12:00:00.000Z");

test("computeSyncFreshness: no state at all (row missing) -> stale, idle", () => {
  const freshness = computeSyncFreshness(null, NOW);
  assert.equal(freshness.isStale, true);
  assert.equal(freshness.lastSuccessAt, null);
  assert.equal(freshness.status, "idle");
});

test("computeSyncFreshness: never successfully synced (lastSuccessAt null) -> stale, regardless of status", () => {
  const freshness = computeSyncFreshness({ status: "failed", lastSuccessAt: null }, NOW);
  assert.equal(freshness.isStale, true);
  assert.equal(freshness.status, "failed");
});

test("computeSyncFreshness: last success exactly at the TTL boundary -> stale (>=, not >)", () => {
  const lastSuccessAt = new Date(NOW.getTime() - META_SYNC_FRESHNESS_TTL_MS).toISOString();
  const freshness = computeSyncFreshness({ status: "success", lastSuccessAt }, NOW);
  assert.equal(freshness.isStale, true);
});

test("computeSyncFreshness: last success 11 minutes ago -> stale, sync should be requested", () => {
  const lastSuccessAt = new Date(NOW.getTime() - 11 * 60 * 1000).toISOString();
  const freshness = computeSyncFreshness({ status: "success", lastSuccessAt }, NOW);
  assert.equal(freshness.isStale, true);
});

test("computeSyncFreshness: last success 3 minutes ago -> fresh, no sync requested", () => {
  const lastSuccessAt = new Date(NOW.getTime() - 3 * 60 * 1000).toISOString();
  const freshness = computeSyncFreshness({ status: "success", lastSuccessAt }, NOW);
  assert.equal(freshness.isStale, false);
  assert.equal(freshness.lastSuccessAt, lastSuccessAt);
});
