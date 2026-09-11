import type { SupabaseClient } from "@supabase/supabase-js";

// Daily Instagram account follower-count snapshot — see
// supabase/migrations/20260911150000_..._instagram_account_daily_metrics.sql
// for the full "why" (a live Meta API audit confirmed there is no
// paid-attributed per-campaign follower metric, and no historical
// follower time series reachable today). This file's job is narrow:
// fetch today's real followers_count and store it; separately, compute
// an honest, never-fabricated account-wide delta between two dates from
// whatever real snapshots exist.
//
// TRUSTED SERVER-ONLY CODE — same rule as lib/meta/campaign-sync.ts:
// never import from a Server Component or anything reachable from the
// browser. Called only from app/api/meta/sync-trigger/route.ts.

const META_API_VERSION = "v21.0";

export type InstagramProfileSnapshot = {
  id: string;
  username: string | null;
  followersCount: number;
};

export async function fetchInstagramFollowerCount(
  igUserId: string,
  token: string
): Promise<InstagramProfileSnapshot> {
  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}/${igUserId}`);
  url.searchParams.set("fields", "id,username,followers_count");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  if (!res.ok || json.error) {
    const err = json.error ?? {};
    throw new Error(
      `Instagram Graph API error (HTTP ${res.status}): ${err.type ?? "unknown"} ${err.code ?? ""} — ${
        err.message ?? "no message"
      }`
    );
  }
  return {
    id: String(json.id),
    username: json.username ?? null,
    followersCount: Number(json.followers_count ?? 0),
  };
}

// Upserts today's real snapshot (never backfills a past date). Safe to
// call more than once on the same Israel-calendar day — always keeps
// that day's latest read, same idempotency shape as
// meta_campaign_daily_metrics' own upsert.
export async function syncInstagramFollowerSnapshot({
  supabase,
  metaToken,
  igUserId,
  todayDateKey,
}: {
  supabase: SupabaseClient;
  metaToken: string;
  igUserId: string;
  /** Israel-calendar "YYYY-MM-DD" (see lib/crm/timezone.ts::zonedParts). */
  todayDateKey: string;
}): Promise<{ followerCount: number }> {
  const profile = await fetchInstagramFollowerCount(igUserId, metaToken);

  const { error } = await supabase.from("instagram_account_daily_metrics").upsert(
    {
      metric_date: todayDateKey,
      ig_user_id: profile.id,
      follower_count: profile.followersCount,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "metric_date" }
  );
  if (error) throw new Error(`instagram_account_daily_metrics upsert failed: ${error.message}`);

  return { followerCount: profile.followersCount };
}

export type FollowerSnapshotRow = { metric_date: string; follower_count: number };

// Account-WIDE (never campaign-attributed) follower change between two
// dates, using only real snapshots that genuinely exist — the closest
// available snapshot on/before `sinceDateKey` and the closest available
// snapshot on/after `untilDateKey`. Returns null (never a fabricated or
// interpolated number) when either bound has no bracketing snapshot at
// all — e.g. before any snapshot collection began, or for a period
// entirely outside the snapshot history collected so far.
export function computeAccountFollowerChange(
  snapshots: FollowerSnapshotRow[],
  sinceDateKey: string,
  untilDateKey: string
): { changeCount: number } | null {
  let startSnapshot: FollowerSnapshotRow | null = null;
  let endSnapshot: FollowerSnapshotRow | null = null;

  for (const s of snapshots) {
    if (s.metric_date <= sinceDateKey) {
      if (!startSnapshot || s.metric_date > startSnapshot.metric_date) startSnapshot = s;
    }
    if (s.metric_date >= untilDateKey) {
      if (!endSnapshot || s.metric_date < endSnapshot.metric_date) endSnapshot = s;
    }
  }

  if (!startSnapshot || !endSnapshot) return null;
  return { changeCount: endSnapshot.follower_count - startSnapshot.follower_count };
}
