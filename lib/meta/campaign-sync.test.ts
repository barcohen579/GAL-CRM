import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ilsToAgorot,
  mergeCampaignMetadata,
  resolveConfiguredAccountIds,
  resolveDateRangeForAccount,
  type CampaignMetadata,
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

// Deliberately includes today (see campaign-sync.ts's own comment): a
// live Production investigation found a same-day campaign whose entire
// spend history was "today", invisible under the old "ending yesterday"
// window until the FOLLOWING day's sync no matter how many times the
// Dashboard was opened. Meta's own date_preset=yesterday Insights call
// for that account returned zero rows -- confirming there was nothing
// to show for yesterday while there WAS already real spend for today.
test("resolveDateRangeForAccount: default (no argv) -> trailing 7 days ENDING TODAY (today's partial spend must be visible)", () => {
  const { since, until, mode } = resolveDateRangeForAccount([], "UTC");
  assert.equal(mode, "default-trailing-7d");
  const todayUtc = new Date().toISOString().slice(0, 10);
  assert.equal(until, todayUtc, "the window must reach today, or a same-day campaign's spend is invisible until tomorrow");
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

test("mergeCampaignMetadata: attaches real objective/effectiveStatus by campaign_id", () => {
  const metadataById = new Map<string, CampaignMetadata>([
    ["120247020269420068", { objective: "OUTCOME_ENGAGEMENT", effectiveStatus: "ACTIVE" }],
  ]);
  const merged = mergeCampaignMetadata(
    [{ campaign_id: "120247020269420068", campaign_name: "קמפיין מעורבות חדש" }],
    metadataById
  );
  assert.equal(merged[0].objective, "OUTCOME_ENGAGEMENT");
  assert.equal(merged[0].effectiveStatus, "ACTIVE");
  assert.equal(merged[0].campaign_name, "קמפיין מעורבות חדש");
});

test("mergeCampaignMetadata: a campaign_id with no metadata gets null, never fabricated", () => {
  const merged = mergeCampaignMetadata(
    [{ campaign_id: "unknown-campaign" }],
    new Map<string, CampaignMetadata>()
  );
  assert.equal(merged[0].objective, null);
  assert.equal(merged[0].effectiveStatus, null);
});

test("mergeCampaignMetadata: matches by string campaign_id even when the row's id is numeric", () => {
  const metadataById = new Map<string, CampaignMetadata>([
    ["12345", { objective: "OUTCOME_LEADS", effectiveStatus: "ACTIVE" }],
  ]);
  const merged = mergeCampaignMetadata([{ campaign_id: 12345 }], metadataById);
  assert.equal(merged[0].objective, "OUTCOME_LEADS");
});
