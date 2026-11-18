-- =============================================================================
-- Crazy Larry's Dumpsters — rental-agreement mode for online booking
-- =============================================================================
-- The owner's half of the two-key DocuSign switch (docusign-port, task 4).
--
--   attest    today's /book: the PowerForm link plus the "I signed it" checkbox.
--   docusign  the embedded DocuSign envelope, verified server-side before the
--             charge.
--
-- The app uses DocuSign only when this says 'docusign' AND the deployment has
-- the capability (CL_DOCUSIGN_ENABLED=1 plus every DOCUSIGN_* variable).
-- Preview and Production share this database, so this setting alone never
-- switches a deployment that lacks the capability. Default attest; anything
-- the app can't read is attest too.
--
-- 1. cl_agreement_settings: singleton row, the same pattern as
--    cl_booking_settings, built from its LIVE definition (read 2026-11-17):
--      id boolean pk default true check (id); RLS on; "staff read"
--      (is_staff) and "owner update" (is_owner) for authenticated; table
--      grants revoked from public, anon, authenticated, then SELECT and
--      column UPDATE granted back; triggers set_updated_at (live md5
--      4d6804d5…) and a stamp of updated_by from auth.uid().
--    mode text not null default 'attest', checked to the two values. Owners
--    update that one column; nobody but the owner role (postgres) and
--    service_role inserts or deletes.
-- 2. _stamp_agreement_settings(): the updated_by trigger, a copy of
--    _stamp_booking_settings (live, md5 5da663be…) under its own name so the
--    two tables don't share a function. EXECUTE revoked from every API role.
-- 3. booking_agreement_mode(): SECURITY DEFINER, service_role only. /book is
--    anonymous and checkout runs as service_role, so this is how they read
--    the mode, the way they read the cutoff (booking_delivery_floor). A
--    missing row, or anything but 'docusign', reads as 'attest'.
--
-- NOT changed: cl_booking_settings and its functions, create_booking and the
-- core. The database does not require an agreement session in either mode
-- (planned for later, after the PowerForm is retired); this only steers the
-- app.
-- =============================================================================

create table public.cl_agreement_settings (
  id         boolean primary key default true check (id),
  mode       text not null default 'attest',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  constraint cl_agreement_settings_mode_check check (mode in ('attest', 'docusign'))
);

comment on table public.cl_agreement_settings is
  'Singleton. How online customers sign the rental agreement. The app uses docusign only if the deployment also has CL_DOCUSIGN_ENABLED=1 and every DOCUSIGN_* variable; otherwise attest.';
comment on column public.cl_agreement_settings.mode is
  'attest (PowerForm + checkbox) or docusign (embedded envelope, verified before the charge).';

insert into public.cl_agreement_settings (id) values (true);

alter table public.cl_agreement_settings enable row level security;

create policy "cl_agreement_settings: staff read" on public.cl_agreement_settings
  for select to authenticated using (public.is_staff());
create policy "cl_agreement_settings: owner update" on public.cl_agreement_settings
  for update to authenticated using (public.is_owner()) with check (public.is_owner());

revoke all on public.cl_agreement_settings from public, anon, authenticated;
grant select on public.cl_agreement_settings to authenticated;
grant update (mode) on public.cl_agreement_settings to authenticated;

create trigger cl_agreement_settings_set_updated_at
  before update on public.cl_agreement_settings
  for each row execute function public.set_updated_at();

create function public._stamp_agreement_settings()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_by := auth.uid();
  return new;
end;
$$;

-- A trigger function: nobody calls it. EXECUTE is checked when the trigger is
-- created, not when it fires, so it is revoked from every API role.
revoke all on function public._stamp_agreement_settings() from public, anon, authenticated, service_role;

create trigger cl_agreement_settings_stamp
  before update on public.cl_agreement_settings
  for each row execute function public._stamp_agreement_settings();

-- -----------------------------------------------------------------------------
-- booking_agreement_mode
-- -----------------------------------------------------------------------------
create function public.booking_agreement_mode()
returns text
language sql
stable
security definer
set search_path = public
as $$
  -- DEFINER so service_role gets this one answer without a policy of its own;
  -- anything but 'docusign' (row missing included) reads as attest.
  select case
    when (select s.mode from public.cl_agreement_settings s where s.id) = 'docusign'
      then 'docusign'
    else 'attest'
  end
$$;

revoke all on function public.booking_agreement_mode() from public, anon, authenticated;
grant execute on function public.booking_agreement_mode() to service_role;
