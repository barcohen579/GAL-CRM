-- Regression test for meta_sync_state
-- (supabase/migrations/20260911120000_..._meta_sync_state.sql) — the
-- Meta sync freshness/concurrency-lock record backing the automatic
-- Dashboard refresh (lib/meta/sync-state-repo.ts,
-- lib/meta/sync-orchestrator.ts).
--
-- True concurrent-request behavior (two simultaneous claims) is covered
-- by lib/meta/sync-orchestrator.test.ts against an in-memory fake with
-- the same atomicity semantics — a single Postgres connection can't
-- exercise real concurrency. This script instead pins the schema-level
-- invariants: exactly one seed row, the claim UPDATE...WHERE's exact
-- transition behavior, and the RLS/grant shape.
--
-- Same style as the project's other regression tests: a self-contained,
-- ASSERTION-BASED (RAISEs on the first mismatch), BEGIN/ROLLBACK script.
--
-- Run with:
--   npx supabase db query --linked -f supabase/tests/meta_sync_state.test.sql
--
-- A clean run prints only a final "ALL ASSERTIONS PASSED" row and leaves
-- the database completely unchanged (ROLLBACK at the end).

begin;

do $$
declare
  v_count int;
  v_row record;
  v_stale_threshold_iso text;
begin
  -----------------------------------------------------------------
  -- Scenario 1: exactly one seed row, source = 'META'.
  -----------------------------------------------------------------
  select count(*) into v_count from public.meta_sync_state where source = 'META';
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (Scenario 1): expected exactly one META row, found %', v_count;
  end if;

  -----------------------------------------------------------------
  -- Scenario 2: the claim UPDATE...WHERE (lib/meta/sync-state-repo.ts
  -- ::claimRun) transitions a non-'running' row to 'running' and
  -- returns it.
  -----------------------------------------------------------------
  update public.meta_sync_state set status = 'idle' where source = 'META';

  update public.meta_sync_state
  set status = 'running', last_attempt_started_at = now()
  where source = 'META'
    and (status <> 'running' or last_attempt_started_at < now() - interval '5 minutes')
  returning * into v_row;

  if v_row.status is distinct from 'running' then
    raise exception 'ASSERTION FAILED (Scenario 2): claim did not transition an idle row to running';
  end if;

  -----------------------------------------------------------------
  -- Scenario 3: a FRESH 'running' row (claimed moments ago) is NOT
  -- claimable again — this is the concurrency lock itself.
  -----------------------------------------------------------------
  update public.meta_sync_state
  set status = 'running', last_attempt_started_at = now()
  where source = 'META'
    and (status <> 'running' or last_attempt_started_at < now() - interval '5 minutes');
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    raise exception 'ASSERTION FAILED (Scenario 3): a fresh running lock was incorrectly re-claimed';
  end if;

  -----------------------------------------------------------------
  -- Scenario 4: a STALE 'running' row (stuck past the threshold —
  -- e.g. the process crashed mid-sync) IS reclaimable.
  -----------------------------------------------------------------
  update public.meta_sync_state
  set last_attempt_started_at = now() - interval '10 minutes'
  where source = 'META';

  update public.meta_sync_state
  set status = 'running', last_attempt_started_at = now()
  where source = 'META'
    and (status <> 'running' or last_attempt_started_at < now() - interval '5 minutes');
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception 'ASSERTION FAILED (Scenario 4): a stale running lock was not reclaimable';
  end if;

  -----------------------------------------------------------------
  -- Scenario 5: a successful attempt sets last_success_at; a
  -- subsequent FAILED attempt updates status/last_error but must NOT
  -- touch last_success_at.
  -----------------------------------------------------------------
  update public.meta_sync_state
  set status = 'success', last_attempt_finished_at = now(), last_success_at = now(), last_error = null
  where source = 'META';

  select last_success_at into v_row from public.meta_sync_state where source = 'META';
  if v_row.last_success_at is null then
    raise exception 'ASSERTION FAILED (Scenario 5): last_success_at was not set on success';
  end if;

  declare
    v_success_at timestamptz;
  begin
    select last_success_at into v_success_at from public.meta_sync_state where source = 'META';

    update public.meta_sync_state
    set status = 'failed', last_attempt_finished_at = now(), last_error = 'Meta API error (sanitized)'
    where source = 'META';

    select last_success_at into v_row from public.meta_sync_state where source = 'META';
    if v_row.last_success_at is distinct from v_success_at then
      raise exception 'ASSERTION FAILED (Scenario 5): a failed attempt altered last_success_at';
    end if;
  end;

  -----------------------------------------------------------------
  -- Scenario 6: RLS — authenticated has SELECT only, no
  -- insert/update/delete policy exists for it at all. Same "no write
  -- policy for authenticated" shape as meta_campaign_daily_metrics.
  -----------------------------------------------------------------
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'meta_sync_state'
      and cmd in ('INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'ASSERTION FAILED (Scenario 6): a write policy exists on meta_sync_state for some role -- must not';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'meta_sync_state' and cmd = 'SELECT'
  ) then
    raise exception 'ASSERTION FAILED (Scenario 6): no SELECT policy exists on meta_sync_state';
  end if;

  -----------------------------------------------------------------
  -- Scenario 7: grants — authenticated has SELECT only; service_role
  -- has SELECT, INSERT, UPDATE (no DELETE for anyone).
  -----------------------------------------------------------------
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'meta_sync_state'
      and grantee = 'authenticated' and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'ASSERTION FAILED (Scenario 7): authenticated has a write grant on meta_sync_state -- must not';
  end if;
  if not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'meta_sync_state'
      and grantee = 'service_role' and privilege_type = 'SELECT'
  ) or not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'meta_sync_state'
      and grantee = 'service_role' and privilege_type = 'INSERT'
  ) or not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'meta_sync_state'
      and grantee = 'service_role' and privilege_type = 'UPDATE'
  ) then
    raise exception 'ASSERTION FAILED (Scenario 7): service_role is missing an expected select/insert/update grant';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'meta_sync_state'
      and grantee = 'service_role' and privilege_type = 'DELETE'
  ) then
    raise exception 'ASSERTION FAILED (Scenario 7): service_role has a DELETE grant on meta_sync_state -- must not';
  end if;

  raise notice 'ALL ASSERTIONS PASSED';
end $$;

select 'ALL ASSERTIONS PASSED' as result;

rollback;
