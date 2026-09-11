import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAccountFollowerChange, type FollowerSnapshotRow } from "./instagram-follower-sync.ts";

test("computeAccountFollowerChange: a genuine bracketed delta between real snapshots", () => {
  const snapshots: FollowerSnapshotRow[] = [
    { metric_date: "2026-09-03", follower_count: 1000 },
    { metric_date: "2026-09-08", follower_count: 1012 },
    { metric_date: "2026-09-11", follower_count: 1018 },
  ];
  const result = computeAccountFollowerChange(snapshots, "2026-09-04", "2026-09-11");
  // since=09-04 -> closest snapshot on/before it is 09-03 (1000).
  // until=09-11 -> closest snapshot on/after it is 09-11 (1018).
  assert.deepEqual(result, { changeCount: 18 });
});

test("computeAccountFollowerChange: exactly zero followers gained is a real 0, not omitted", () => {
  const snapshots: FollowerSnapshotRow[] = [
    { metric_date: "2026-09-04", follower_count: 1000 },
    { metric_date: "2026-09-11", follower_count: 1000 },
  ];
  const result = computeAccountFollowerChange(snapshots, "2026-09-04", "2026-09-11");
  assert.deepEqual(result, { changeCount: 0 });
});

test("computeAccountFollowerChange: a follower DECREASE is a real negative number", () => {
  const snapshots: FollowerSnapshotRow[] = [
    { metric_date: "2026-09-04", follower_count: 1050 },
    { metric_date: "2026-09-11", follower_count: 1030 },
  ];
  const result = computeAccountFollowerChange(snapshots, "2026-09-04", "2026-09-11");
  assert.deepEqual(result, { changeCount: -20 });
});

test("computeAccountFollowerChange: no snapshot at or before `since` -> null, never fabricated/interpolated", () => {
  const snapshots: FollowerSnapshotRow[] = [{ metric_date: "2026-09-11", follower_count: 1030 }];
  const result = computeAccountFollowerChange(snapshots, "2026-09-04", "2026-09-11");
  assert.equal(result, null);
});

test("computeAccountFollowerChange: no snapshot at or after `until` -> null", () => {
  const snapshots: FollowerSnapshotRow[] = [{ metric_date: "2026-09-04", follower_count: 1000 }];
  const result = computeAccountFollowerChange(snapshots, "2026-09-04", "2026-09-11");
  assert.equal(result, null);
});

test("computeAccountFollowerChange: no snapshots at all (feature just enabled, nothing collected yet) -> null", () => {
  const result = computeAccountFollowerChange([], "2026-09-04", "2026-09-11");
  assert.equal(result, null);
});

test("computeAccountFollowerChange: picks the CLOSEST bracketing snapshot on each side, not the first/last in the array", () => {
  const snapshots: FollowerSnapshotRow[] = [
    { metric_date: "2026-09-01", follower_count: 900 }, // too far before `since`
    { metric_date: "2026-09-03", follower_count: 995 }, // closest before `since`
    { metric_date: "2026-09-12", follower_count: 1020 }, // closest after `until`
    { metric_date: "2026-09-15", follower_count: 1040 }, // too far after `until`
  ];
  const result = computeAccountFollowerChange(snapshots, "2026-09-04", "2026-09-11");
  assert.deepEqual(result, { changeCount: 25 }); // 1020 - 995
});

test("computeAccountFollowerChange: a same-day window (since === until) with exactly one matching snapshot resolves to a real 0-length comparison, not a crash", () => {
  const snapshots: FollowerSnapshotRow[] = [{ metric_date: "2026-09-11", follower_count: 1030 }];
  const result = computeAccountFollowerChange(snapshots, "2026-09-11", "2026-09-11");
  assert.deepEqual(result, { changeCount: 0 });
});

test("computeAccountFollowerChange: the result shape never contains NaN/Infinity for any real integer inputs", () => {
  const snapshots: FollowerSnapshotRow[] = [
    { metric_date: "2026-09-04", follower_count: 0 },
    { metric_date: "2026-09-11", follower_count: 12 },
  ];
  const result = computeAccountFollowerChange(snapshots, "2026-09-04", "2026-09-11");
  assert.ok(result !== null && Number.isFinite(result.changeCount));
});
