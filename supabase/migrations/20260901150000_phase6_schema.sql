-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 6 (A): scheduling & driver management schema
-- =============================================================================
--   * bookings.job_tags           — coarse categories for job_tag-dimension
--                                    truck restrictions (roofing, heavy_construction)
--   * bookings.job_tags_confirmed_at — a dispatcher reviewed the tags. Until set,
--     assigning to a truck that has job_tag block restrictions triggers an
--     'untagged_review' warning (Phase 6 C).
--   * trucks: one driver per truck
--   * drop the driver job-UPDATE RLS policy — drivers become SELECT-only; their
--     only write path is complete_job (Phase 6 C).
-- =============================================================================

alter table public.bookings
  add column job_tags text[] not null default '{}',
  add column job_tags_confirmed_at timestamptz;

create index bookings_job_tags_idx on public.bookings using gin (job_tags);

-- One driver drives at most one truck.
alter table public.trucks
  add constraint trucks_assigned_driver_id_key unique (assigned_driver_id);
-- NULLs are allowed to repeat under a UNIQUE constraint, so multiple trucks
-- with no driver is fine.

-- -----------------------------------------------------------------------------
-- Tighten driver job access: SELECT only.
-- -----------------------------------------------------------------------------
-- The old policy let a driver UPDATE their assigned job's status / route_order /
-- even driver_id directly via PostgREST. All job mutation now goes through
-- SECURITY DEFINER RPCs (assign_job / complete_job / ...), which check
-- is_staff() OR "owns this job".
drop policy if exists "jobs: driver updates assigned jobs" on public.jobs;

-- "jobs: driver reads assigned jobs" (SELECT) and "jobs: staff full access"
-- (ALL) stay as they are.
