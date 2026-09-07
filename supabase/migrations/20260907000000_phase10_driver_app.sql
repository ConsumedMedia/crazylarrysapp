-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 10: driver app (chrome, photo capture, map)
--   1. job_photos — completion photos, tracked separately from complete_job
--      so a failed upload never blocks a driver from closing out a job
--   2. job-photos Storage bucket (private) + RLS
--   3. trucks: a driver can read their own assigned truck (for the header)
-- =============================================================================

-- =============================================================================
-- 1. JOB PHOTOS
-- =============================================================================
-- A table, not a column on jobs — keeps the door open for more than one
-- angle later without another migration, and lets staff query "which drop
-- jobs finished with no photo" as a plain join instead of new bookkeeping.
create table public.job_photos (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.jobs (id) on delete restrict,
  storage_path  text not null,
  uploaded_by   uuid not null references public.profiles (id) on delete restrict,
  created_at    timestamptz not null default now()
);

create index job_photos_job_id_idx on public.job_photos (job_id);

alter table public.job_photos enable row level security;

create policy "job_photos: staff full access"
  on public.job_photos for all
  using (public.is_staff()) with check (public.is_staff());

create policy "job_photos: driver inserts own job photos"
  on public.job_photos for insert
  with check (
    uploaded_by = auth.uid()
    and exists (
      select 1 from public.jobs j
      join public.drivers d on d.id = j.driver_id
      where j.id = job_photos.job_id
        and d.profile_id = auth.uid()
    )
  );

create policy "job_photos: driver reads own job photos"
  on public.job_photos for select
  using (
    exists (
      select 1 from public.jobs j
      join public.drivers d on d.id = j.driver_id
      where j.id = job_photos.job_id
        and d.profile_id = auth.uid()
    )
  );

-- =============================================================================
-- 2. STORAGE BUCKET — private (photos show residential addresses / property);
--    staff view them via short-lived signed URLs generated server-side with
--    the service-role client, not a public bucket URL.
-- =============================================================================
insert into storage.buckets (id, name, public)
values ('job-photos', 'job-photos', false)
on conflict (id) do nothing;

-- Path convention: <job_id>/<uuid>.<ext> — storage.foldername(name)[1] is the
-- job id, checked against the uploading driver's own assigned jobs.
create policy "job-photos: driver uploads own job photos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'job-photos'
    and exists (
      select 1 from public.jobs j
      join public.drivers d on d.id = j.driver_id
      where d.profile_id = auth.uid()
        and j.id::text = (storage.foldername(name))[1]
    )
  );

create policy "job-photos: staff full access"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'job-photos' and public.is_staff())
  with check (bucket_id = 'job-photos' and public.is_staff());

-- =============================================================================
-- 3. TRUCKS — a driver may read the truck they're currently assigned to
--    (the driver-app header shows it; previously staff-only).
-- =============================================================================
create policy "trucks: driver reads own assigned truck"
  on public.trucks for select
  using (
    exists (
      select 1 from public.drivers d
      where d.id = trucks.assigned_driver_id
        and d.profile_id = auth.uid()
    )
  );
