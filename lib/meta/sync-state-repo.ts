import type { SupabaseClient } from "@supabase/supabase-js";
import type { MetaSyncStatus } from "./sync-freshness.ts";

// Data-access layer for meta_sync_state, expressed as an interface
// (MetaSyncStateRepo) rather than direct Supabase calls sprinkled through
// lib/meta/sync-orchestrator.ts — the same shape as
// lib/meta/repo.ts::MetaIngestionRepo, for the same reason: it's what
// makes the concurrency/freshness LOGIC unit-testable without a live
// database (see lib/meta/sync-fakes.ts + lib/meta/sync-orchestrator.test.ts)
// while createSupabaseMetaSyncStateRepo below is the only real
// implementation, used exclusively by Route Handlers
// (app/api/meta/sync/trigger/route.ts) via a service-role admin client —
// never imported by a Server Component.

export type MetaSyncStateRow = {
  source: string;
  status: MetaSyncStatus;
  lastAttemptStartedAt: string | null;
  lastAttemptFinishedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
};

export interface MetaSyncStateRepo {
  getState(): Promise<MetaSyncStateRow | null>;
  /** Atomic conditional UPDATE: any non-'running' row, or a 'running' row
   *  stuck past META_SYNC_STALE_LOCK_MS, becomes 'running' and is
   *  returned. Returns null (claims nothing) when a genuinely fresh sync
   *  is already in progress — the caller must treat that as "someone
   *  else is handling it", never retry the claim itself. This is the
   *  server-side concurrency lock: two Dashboard tabs, or Bar and Gal
   *  opening the CRM at once, can both attempt to claim, but only one
   *  UPDATE actually commits first — Postgres serializes the loser
   *  against the winner's row lock, exactly like
   *  lib/meta/repo.ts::claimForProcessing. */
  claimRun(now?: Date): Promise<MetaSyncStateRow | null>;
  markSuccess(now?: Date): Promise<void>;
  /** Sets status='failed' and the (already-sanitized) error message.
   *  Deliberately never touches last_success_at — a failed attempt must
   *  never make the Dashboard's data look fresher than it actually is. */
  markFailure(sanitizedErrorMessage: string, now?: Date): Promise<void>;
}

// A 'running' row stuck past this long is treated as abandoned (the
// process that claimed it crashed/was killed before finishing) and
// becomes reclaimable. Comfortably longer than a real 2-account sync
// should ever take, comfortably shorter than the 10-minute freshness TTL
// (META_SYNC_FRESHNESS_TTL_MS in sync-freshness.ts) so a genuinely stuck
// run doesn't block freshness-sensing for long — same reasoning as
// STALE_PROCESSING_MS in lib/meta/repo.ts.
export const META_SYNC_STALE_LOCK_MS = 5 * 60 * 1000;

type RawSyncStateRow = {
  source: string;
  status: MetaSyncStatus;
  last_attempt_started_at: string | null;
  last_attempt_finished_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
};

function mapRow(row: RawSyncStateRow): MetaSyncStateRow {
  return {
    source: row.source,
    status: row.status,
    lastAttemptStartedAt: row.last_attempt_started_at,
    lastAttemptFinishedAt: row.last_attempt_finished_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
  };
}

const SOURCE = "META";
const SELECT_COLUMNS =
  "source, status, last_attempt_started_at, last_attempt_finished_at, last_success_at, last_error";

export function createSupabaseMetaSyncStateRepo(supabase: SupabaseClient): MetaSyncStateRepo {
  return {
    async getState() {
      const { data, error } = await supabase
        .from("meta_sync_state")
        .select(SELECT_COLUMNS)
        .eq("source", SOURCE)
        .maybeSingle();
      if (error) throw new Error(`meta_sync_state lookup failed: ${error.message}`);
      return data ? mapRow(data) : null;
    },

    async claimRun(now = new Date()) {
      const staleThresholdIso = new Date(now.getTime() - META_SYNC_STALE_LOCK_MS).toISOString();
      const { data, error } = await supabase
        .from("meta_sync_state")
        .update({ status: "running", last_attempt_started_at: now.toISOString() })
        .eq("source", SOURCE)
        .or(`status.neq.running,last_attempt_started_at.lt.${staleThresholdIso}`)
        .select(SELECT_COLUMNS)
        .maybeSingle();
      if (error) throw new Error(`meta_sync_state claim failed: ${error.message}`);
      return data ? mapRow(data) : null;
    },

    async markSuccess(now = new Date()) {
      const { error } = await supabase
        .from("meta_sync_state")
        .update({
          status: "success",
          last_attempt_finished_at: now.toISOString(),
          last_success_at: now.toISOString(),
          last_error: null,
        })
        .eq("source", SOURCE);
      if (error) throw new Error(`meta_sync_state markSuccess failed: ${error.message}`);
    },

    async markFailure(sanitizedErrorMessage, now = new Date()) {
      const { error } = await supabase
        .from("meta_sync_state")
        .update({
          status: "failed",
          last_attempt_finished_at: now.toISOString(),
          last_error: sanitizedErrorMessage,
        })
        .eq("source", SOURCE);
      if (error) throw new Error(`meta_sync_state markFailure failed: ${error.message}`);
    },
  };
}
