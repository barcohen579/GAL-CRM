import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ilsToAgorot,
  resolveConfiguredAccountIds,
  resolveDateRangeForAccount,
} from "./campaign-sync.ts";

test("resolveConfiguredAccountIds: both configured GAL CRM production accounts are included", () => {
  const ids = resolveConfiguredAccountIds({
    META_AD_ACCOUNT_IDS: "act_2070492616442158,act_101145727",
  });
  assert.deepEqual(ids, ["act_2070492616442158", "act_101145727"]);
});

test("resolveConfiguredAccountIds: normalizes ids missing the act_ prefix and trims whitespace", () => {
  const ids = resolveConfiguredAccountIds({ META_AD_ACCOUNT_IDS: " 2070492616442158 , act_101145727 " });
  assert.deepEqual(ids, ["act_2070492616442158", "act_101145727"]);
});

test("resolveConfiguredAccountIds: falls back to the singular META_AD_ACCOUNT_ID", () => {
  const ids = resolveConfiguredAccountIds({ META_AD_ACCOUNT_ID: "act_101145727" });
  assert.deepEqual(ids, ["act_101145727"]);
});

test("resolveConfiguredAccountIds: no env configured -> empty list", () => {
  assert.deepEqual(resolveConfiguredAccountIds({}), []);
});

test("resolveDateRangeForAccount: default (no argv) -> trailing 7 completed days, never including today", () => {
  const { since, until, mode } = resolveDateRangeForAccount([], "UTC");
  assert.equal(mode, "default-trailing-7d");
  const todayUtc = new Date().toISOString().slice(0, 10);
  assert.notEqual(until, todayUtc, "the window must never include the still-open current day");
  const days = (new Date(until + "T00:00:00Z").getTime() - new Date(since + "T00:00:00Z").getTime()) / 86_400_000;
  assert.equal(days, 6, "7 inclusive days = a 6-day span between since and until");
});

test("resolveDateRangeForAccount: explicit [since, until] argv applies as-is", () => {
  const range = resolveDateRangeForAccount(["2026-08-20", "2026-08-26"], "Asia/Jerusalem");
  assert.deepEqual(range, { since: "2026-08-20", until: "2026-08-26", mode: "explicit" });
});

test("resolveDateRangeForAccount: an invalid explicit range throws (caught per-account by the caller)", () => {
  assert.throws(() => resolveDateRangeForAccount(["not-a-date", "2026-08-26"], "UTC"));
});

test("ilsToAgorot: converts Meta's decimal ILS string to integer agorot", () => {
  assert.equal(ilsToAgorot("20.99"), 2099);
  assert.equal(ilsToAgorot("0"), 0);
  assert.equal(ilsToAgorot(15), 1500);
});

test("ilsToAgorot: rejects a negative or non-finite spend value", () => {
  assert.throws(() => ilsToAgorot("-5"));
  assert.throws(() => ilsToAgorot("not-a-number"));
});
