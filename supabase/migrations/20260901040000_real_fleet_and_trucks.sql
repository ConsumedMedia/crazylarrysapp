-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 2 addendum
--   1. Replace placeholder fleet with Larry's real 28-unit fleet
--   2. Add trucks + truck_restrictions (structured operational rules)
-- =============================================================================
-- Idempotent: re-running makes no further changes.

-- =============================================================================
-- 1. REAL FLEET
-- =============================================================================

-- 1a. Purge the placeholder units (CL-### convention) and their history.
--     DELETE is naturally idempotent.
delete from public.status_log
where entity_type = 'dumpster'
  and entity_id in (
    select id from public.dumpsters where unit_number like 'CL-%'
  );

delete from public.dumpsters where unit_number like 'CL-%';

-- 1b. Seed the real fleet. Larry's ID convention is "<size>-<sequence>":
--       15 x 20yd : 20-30 .. 20-44
--        6 x 15yd : 15-01 .. 15-06
--        7 x 10yd : 10-01 .. 10-07
--     All start 'available'. The dumpsters_log_created trigger (added in
--     20260901020000) writes the fresh opening status_log row for each unit
--     (old_status NULL, new_status 'available', now()) — so unlike the
--     placeholder seed we do NOT disable it here: one clean opening row per
--     unit is exactly what we want.
insert into public.dumpsters (unit_number, size, status)
select '20-' || g::text, '20yd'::public.dumpster_size, 'available'::public.dumpster_status
from generate_series(30, 44) as g
union all
select '15-' || lpad(g::text, 2, '0'), '15yd', 'available'
from generate_series(1, 6) as g
union all
select '10-' || lpad(g::text, 2, '0'), '10yd', 'available'
from generate_series(1, 7) as g
on conflict (unit_number) do nothing;

-- =============================================================================
-- 2. TRUCKS
-- =============================================================================

create type public.truck_status as enum ('active', 'inactive');

-- Structured decomposition of restriction_notes for Phase 6 assignment logic.
--   customer    -> matched against customers.company_name
--   debris_type -> matched against bookings.debris_type (free text for now)
--   job_tag     -> coarse category not otherwise on the booking
--                  (bookings.job_tags[] arrives in Phase 6; the enum value is
--                   defined now so restriction rows can reference it)
create type public.truck_restriction_dimension as enum
  ('customer', 'debris_type', 'job_tag');

create type public.truck_restriction_match_mode as enum ('exact', 'contains');

create type public.truck_restriction_enforcement as enum ('block', 'warn');

-- 2a. customers.company_name — company/organization name, distinct from the
--     contact's personal full_name. Restriction customer-rules match on this.
alter table public.customers
  add column if not exists company_name text;

-- 2b. trucks
create table public.trucks (
  id                 uuid primary key default gen_random_uuid(),
  year               integer not null check (year between 1980 and 2100),
  make               text not null,
  model              text not null,
  nickname           text not null unique,
  status             public.truck_status not null default 'active',
  current_mileage    integer not null default 0 check (current_mileage >= 0),
  assigned_driver_id uuid references public.drivers (id) on delete set null,
  -- Hard capacity limit: which dumpster sizes the truck can physically carry.
  -- Stored explicitly (all three when unrestricted), never NULL-means-all.
  allowed_sizes      public.dumpster_size[] not null
                       check (cardinality(allowed_sizes) between 1 and 3),
  -- Authoritative human wording; never parsed. truck_restrictions is its
  -- structured decomposition.
  restriction_notes  text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index trucks_status_idx on public.trucks (status);
create index trucks_assigned_driver_id_idx on public.trucks (assigned_driver_id);
create index trucks_allowed_sizes_idx on public.trucks using gin (allowed_sizes);

create trigger trucks_set_updated_at
  before update on public.trucks
  for each row execute function public.set_updated_at();

-- 2c. truck_restrictions — one row per atomic soft-exclusion rule
create table public.truck_restrictions (
  id            uuid primary key default gen_random_uuid(),
  truck_id      uuid not null references public.trucks (id) on delete cascade,
  dimension     public.truck_restriction_dimension not null,
  match_value   text not null check (length(btrim(match_value)) > 0),
  match_mode    public.truck_restriction_match_mode not null default 'exact',
  enforcement   public.truck_restriction_enforcement not null default 'block',
  -- The originating clause from restriction_notes, for traceability.
  source_phrase text,
  created_at    timestamptz not null default now(),
  unique (truck_id, dimension, match_value)
);

create index truck_restrictions_truck_id_idx
  on public.truck_restrictions (truck_id);
create index truck_restrictions_dimension_value_idx
  on public.truck_restrictions (dimension, match_value);

-- =============================================================================
-- 3. ROW LEVEL SECURITY — staff/owner only, same pattern as dumpsters
-- =============================================================================
alter table public.trucks             enable row level security;
alter table public.truck_restrictions enable row level security;

create policy "trucks: staff full access"
  on public.trucks for all
  using (public.is_staff()) with check (public.is_staff());

create policy "truck_restrictions: staff full access"
  on public.truck_restrictions for all
  using (public.is_staff()) with check (public.is_staff());

-- =============================================================================
-- 4. SEED THE TWO REAL TRUCKS
-- =============================================================================
-- The data-modifying CTE always runs to completion even though the primary
-- query reads trucks by nickname instead of from it — so this stays idempotent
-- even if a prior run inserted the trucks but not their restriction rows.
with seed_trucks as (
  insert into public.trucks
    (year, make, model, nickname, status, current_mileage, allowed_sizes, restriction_notes)
  values
    (
      2023, 'Chevrolet', '6500', 'Pepperoni', 'active', 90463,
      array['10yd', '15yd', '20yd']::public.dumpster_size[],
      'Do not use for heavy construction loads, including Shaffer Construction jobs, Bluefield jobs, any roofing jobs, or any stone or concrete jobs. NoCo Exteriors jobs must never be assigned to this truck.'
    ),
    (
      2025, 'Kenworth', 'T280', 'Kenny Powers', 'active', 56184,
      array['15yd', '20yd']::public.dumpster_size[],
      null
    )
  on conflict (nickname) do nothing
  returning id
)
insert into public.truck_restrictions
  (truck_id, dimension, match_value, match_mode, enforcement, source_phrase)
select
  t.id, r.dimension, r.match_value, r.match_mode, r.enforcement, r.source_phrase
from public.trucks t
join (
  values
    ('Pepperoni', 'job_tag'::public.truck_restriction_dimension, 'heavy_construction',
       'exact'::public.truck_restriction_match_mode, 'block'::public.truck_restriction_enforcement,
       'Do not use for heavy construction loads'),
    ('Pepperoni', 'customer', 'Shaffer Construction', 'contains', 'block',
       'including Shaffer Construction jobs'),
    ('Pepperoni', 'customer', 'Bluefield', 'contains', 'block',
       'Bluefield jobs'),
    ('Pepperoni', 'job_tag', 'roofing', 'exact', 'block',
       'any roofing jobs'),
    ('Pepperoni', 'debris_type', 'stone', 'contains', 'block',
       'any stone or concrete jobs'),
    ('Pepperoni', 'debris_type', 'concrete', 'contains', 'block',
       'any stone or concrete jobs'),
    ('Pepperoni', 'customer', 'NoCo Exteriors', 'contains', 'block',
       'NoCo Exteriors jobs must never be assigned to this truck')
) as r(nickname, dimension, match_value, match_mode, enforcement, source_phrase)
  on t.nickname = r.nickname
on conflict (truck_id, dimension, match_value) do nothing;
