-- GAL CRM V1 — multi-service lead interest
--
-- Replaces leads.interested_service (a single nullable enum column)
-- with public.lead_interested_services, a normalized join table — a
-- lead may genuinely be interested in more than one service at once
-- (e.g. Group Training + Nutrition Coaching), and the previous single-
-- value column could never represent that without resorting to
-- comma-separated text, which was explicitly ruled out.
--
-- Design considered and rejected: a text[] or jsonb array column on
-- leads itself would avoid a join but gives up real FK-checked
-- referential integrity to public.service_type, gives up a natural
-- per-row unique constraint against duplicate interest in the same
-- service, and doesn't match this schema's own established convention
-- (every other one-to-many relationship here — lead_stage_events,
-- touchpoints, follow_up_tasks — is already a normalized child table,
-- never an array column on the parent). The join table keeps this
-- schema internally consistent.
--
-- The primary key IS the uniqueness guarantee (lead_id, service_type)
-- — a second INSERT of a lead's already-recorded interest in the same
-- service is rejected by the constraint itself, not just app-level
-- logic (unique_violation, 23505) — this is what "no duplicate
-- service-interest rows for the same lead/service" means at the
-- database level. It also IS the lead_id index this table needs (its
-- leftmost column), so no separate index is added.
--
-- Migration safety: there are currently zero production leads (see
-- the Phase 3E session's own live count check immediately before this
-- migration was written), so this is a no-op in practice today — but
-- is still written to be correct in general: existing single-value
-- interested_service data is copied into the new table BEFORE the old
-- column is dropped, in one transaction, so either both steps succeed
-- together or neither does; no data can be lost partway through.
--
-- Every application code path that reads or writes
-- leads.interested_service was updated in this same commit (Add Lead,
-- /leads, /leads/[id], the dashboard's recent-leads widget, and their
-- shared hand-written types in lib/crm/types.ts) — none is left
-- reading a column that no longer exists. Neither Meta ingestion
-- (lib/meta/repo.ts::createLead) nor create_customer_directly /
-- convert_lead_to_won ever read or wrote interested_service in the
-- first place, so none of those paths are affected by this migration
-- at all.

create table public.lead_interested_services (
  lead_id uuid not null references public.leads(id) on delete cascade,
  service_type public.service_type not null,
  created_at timestamptz not null default now(),
  primary key (lead_id, service_type)
);

comment on table public.lead_interested_services is
  'Which service(s) a lead has expressed interest in — zero, one, or '
  'many. Normalized replacement for the old single-value '
  'leads.interested_service column. The (lead_id, service_type) '
  'primary key is what prevents recording the same interest twice — '
  'not application logic.';

-- Migrate existing data before dropping the old column (no-op today —
-- see the migration-safety note above — but correct in general).
insert into public.lead_interested_services (lead_id, service_type)
select id, interested_service
from public.leads
where interested_service is not null
on conflict (lead_id, service_type) do nothing;

alter table public.leads drop column interested_service;

-- ============================================================
-- Row Level Security — same shape as touchpoints (a mutable set an
-- authorized CRM user can add to or remove from as understanding of
-- the lead evolves), not lead_stage_events' append-only audit-log
-- shape. There is no meaningful UPDATE on a pure (lead_id,
-- service_type) join row — the only operations are adding a service
-- (INSERT) or removing one (DELETE) — so no UPDATE policy/grant is
-- added.
-- ============================================================

alter table public.lead_interested_services enable row level security;

create policy lead_interested_services_crm_select
  on public.lead_interested_services for select
  to authenticated
  using (public.is_crm_user());

create policy lead_interested_services_crm_insert
  on public.lead_interested_services for insert
  to authenticated
  with check (public.is_crm_user());

create policy lead_interested_services_crm_delete
  on public.lead_interested_services for delete
  to authenticated
  using (public.is_crm_user());

grant select, insert, delete on public.lead_interested_services to authenticated;
