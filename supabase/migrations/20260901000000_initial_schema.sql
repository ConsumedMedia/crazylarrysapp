-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 1: initial database schema
-- =============================================================================
-- pgcrypto is assumed already enabled (provides gen_random_uuid()).
-- Safe-guard in case it is not:
create extension if not exists pgcrypto;

-- =============================================================================
-- ENUM TYPES
-- =============================================================================
-- Note: Postgres enums are extensible later via `ALTER TYPE ... ADD VALUE`.

create type public.user_role as enum ('customer', 'driver', 'staff', 'owner');

create type public.dumpster_size as enum ('10yd', '15yd', '20yd');

create type public.dumpster_status as enum (
  'available', 'reserved', 'deployed', 'overdue', 'out_of_service'
);

create type public.booking_status as enum (
  'confirmed', 'delivered', 'active', 'pickup_scheduled',
  'returned', 'overdue', 'cancelled'
);

create type public.job_type as enum ('delivery', 'pickup');

create type public.job_status as enum ('unassigned', 'assigned', 'completed');

create type public.invoice_status as enum ('pending', 'paid', 'refunded', 'failed');

create type public.docusign_status as enum ('not_sent', 'pending', 'signed');

create type public.notification_type as enum (
  'booking_confirmation', 'delivery_reminder', 'delivery_complete',
  'pickup_reminder', 'pickup_complete', 'overdue_notice', 'job_assigned'
);

create type public.notification_channel as enum ('email', 'sms');

create type public.notification_delivery_status as enum ('sent', 'failed');

create type public.status_log_entity as enum ('dumpster', 'booking');

-- =============================================================================
-- TABLES
-- =============================================================================

-- profiles ---------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  role       public.user_role not null default 'customer',
  full_name  text,
  phone      text,
  created_at timestamptz not null default now()
);

-- dumpsters -------------------------------------------------------------------
create table public.dumpsters (
  id              uuid primary key default gen_random_uuid(),
  unit_number     text not null unique,
  size            public.dumpster_size not null,
  status          public.dumpster_status not null default 'available',
  condition_notes text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index dumpsters_status_idx on public.dumpsters (status);

-- customers -----------------------------------------------------------------
-- May optionally link to a profile (account holder); guest bookings leave it null.
create table public.customers (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles (id) on delete set null,
  full_name  text not null,
  email      text,
  phone      text,
  created_at timestamptz not null default now()
);

create index customers_profile_id_idx on public.customers (profile_id);
create index customers_email_idx on public.customers (email);

-- bookings ------------------------------------------------------------------
create table public.bookings (
  id                    uuid primary key default gen_random_uuid(),
  customer_id           uuid not null references public.customers (id) on delete restrict,
  dumpster_id           uuid references public.dumpsters (id) on delete set null,
  size_requested        public.dumpster_size not null,
  delivery_address      text not null,
  delivery_date         date not null,
  pickup_date           date,
  status                public.booking_status not null default 'confirmed',
  placement_notes       text,
  debris_type           text,
  subtotal              numeric(10, 2) not null default 0,
  tax                   numeric(10, 2) not null default 0,
  total                 numeric(10, 2) not null default 0,
  quickbooks_invoice_id text,
  docusign_status       public.docusign_status not null default 'not_sent',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index bookings_customer_id_idx on public.bookings (customer_id);
create index bookings_dumpster_id_idx on public.bookings (dumpster_id);
create index bookings_status_idx on public.bookings (status);
create index bookings_delivery_date_idx on public.bookings (delivery_date);

-- drivers -----------------------------------------------------------------
create table public.drivers (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles (id) on delete restrict,
  full_name    text not null,
  phone        text,
  vehicle_info text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create index drivers_profile_id_idx on public.drivers (profile_id);
create index drivers_active_idx on public.drivers (active);

-- jobs ------------------------------------------------------------------
create table public.jobs (
  id             uuid primary key default gen_random_uuid(),
  booking_id     uuid not null references public.bookings (id) on delete restrict,
  type           public.job_type not null,
  driver_id      uuid references public.drivers (id) on delete set null,
  scheduled_date date not null,
  status         public.job_status not null default 'unassigned',
  route_order    integer,
  completed_at   timestamptz,
  created_at     timestamptz not null default now()
);

create index jobs_booking_id_idx on public.jobs (booking_id);
create index jobs_driver_id_idx on public.jobs (driver_id);
create index jobs_scheduled_date_idx on public.jobs (scheduled_date);
create index jobs_status_idx on public.jobs (status);

-- invoices --------------------------------------------------------------
create table public.invoices (
  id                    uuid primary key default gen_random_uuid(),
  booking_id            uuid not null references public.bookings (id) on delete restrict,
  quickbooks_invoice_id text,
  amount                numeric(10, 2) not null,
  status                public.invoice_status not null default 'pending',
  paid_at               timestamptz,
  created_at            timestamptz not null default now()
);

create index invoices_booking_id_idx on public.invoices (booking_id);
create index invoices_status_idx on public.invoices (status);

-- notifications_log ---------------------------------------------------------
create table public.notifications_log (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid references public.bookings (id) on delete set null,
  driver_id       uuid references public.drivers (id) on delete set null,
  type            public.notification_type not null,
  channel         public.notification_channel not null,
  recipient       text not null,
  sent_at         timestamptz,
  delivery_status public.notification_delivery_status not null default 'sent',
  created_at      timestamptz not null default now()
);

create index notifications_log_booking_id_idx on public.notifications_log (booking_id);
create index notifications_log_driver_id_idx on public.notifications_log (driver_id);
create index notifications_log_type_idx on public.notifications_log (type);

-- status_log -------------------------------------------------------------
-- Polymorphic audit trail; entity_id is not FK-constrained on purpose.
create table public.status_log (
  id          uuid primary key default gen_random_uuid(),
  entity_type public.status_log_entity not null,
  entity_id   uuid not null,
  old_status  text,
  new_status  text not null,
  changed_by  uuid references public.profiles (id) on delete set null,
  changed_at  timestamptz not null default now()
);

create index status_log_entity_idx on public.status_log (entity_type, entity_id);
create index status_log_changed_by_idx on public.status_log (changed_by);
create index status_log_changed_at_idx on public.status_log (changed_at);

-- calendar_blocks --------------------------------------------------------
create table public.calendar_blocks (
  id         uuid primary key default gen_random_uuid(),
  size       public.dumpster_size,          -- null => applies to all sizes
  start_date date not null,
  end_date   date not null,
  reason     text,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint calendar_blocks_date_range_ck check (end_date >= start_date)
);

create index calendar_blocks_created_by_idx on public.calendar_blocks (created_by);
create index calendar_blocks_date_range_idx on public.calendar_blocks (start_date, end_date);

-- call_transcripts -------------------------------------------------------
create table public.call_transcripts (
  id               uuid primary key default gen_random_uuid(),
  quo_call_id      text,
  caller_number    text,
  customer_id      uuid references public.customers (id) on delete set null,
  duration_seconds integer,
  transcript       text,
  summary          text,
  received_at      timestamptz not null default now()
);

create index call_transcripts_customer_id_idx on public.call_transcripts (customer_id);
create index call_transcripts_received_at_idx on public.call_transcripts (received_at);

-- =============================================================================
-- SHARED FUNCTIONS
-- =============================================================================

-- Auto-maintain updated_at on UPDATE.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Current user's role. SECURITY DEFINER so it bypasses RLS on profiles and
-- cannot recurse into profiles' own policies.
create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- Guard: only staff/owner may change a profile's role. A user editing their
-- own row can change full_name / phone but never role.
create or replace function public.enforce_profile_role_change()
returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role and not public.is_staff() then
    raise exception 'Only staff or owner may change a profile role'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- staff OR owner => full read/write across the platform.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_user_role() in ('staff', 'owner');
$$;

-- owner only => reserved for future reporting / config tables.
create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_user_role() = 'owner';
$$;

grant execute on function public.current_user_role() to authenticated;
grant execute on function public.is_staff() to authenticated;
grant execute on function public.is_owner() to authenticated;

-- =============================================================================
-- updated_at TRIGGERS (only tables that carry the column)
-- =============================================================================

create trigger dumpsters_set_updated_at
  before update on public.dumpsters
  for each row execute function public.set_updated_at();

create trigger bookings_set_updated_at
  before update on public.bookings
  for each row execute function public.set_updated_at();

create trigger profiles_enforce_role_change
  before update on public.profiles
  for each row execute function public.enforce_profile_role_change();

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================
-- Every table gets RLS enabled. The `service_role` key (server-side) bypasses
-- RLS automatically, so guest checkout / webhook writes happen there.

alter table public.profiles          enable row level security;
alter table public.dumpsters         enable row level security;
alter table public.customers         enable row level security;
alter table public.bookings          enable row level security;
alter table public.drivers           enable row level security;
alter table public.jobs              enable row level security;
alter table public.invoices          enable row level security;
alter table public.notifications_log enable row level security;
alter table public.status_log        enable row level security;
alter table public.calendar_blocks   enable row level security;
alter table public.call_transcripts  enable row level security;

-- profiles --------------------------------------------------------------------
create policy "profiles: staff full access"
  on public.profiles for all
  using (public.is_staff()) with check (public.is_staff());

create policy "profiles: user reads own"
  on public.profiles for select
  using (id = auth.uid());

create policy "profiles: user updates own"
  on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- dumpsters -----------------------------------------------------------------
create policy "dumpsters: staff full access"
  on public.dumpsters for all
  using (public.is_staff()) with check (public.is_staff());

-- No direct driver access to dumpsters. Drivers see unit_number / size only
-- through their assigned jobs -> bookings -> dumpsters, joined server-side.

-- customers ---------------------------------------------------------------
create policy "customers: staff full access"
  on public.customers for all
  using (public.is_staff()) with check (public.is_staff());

create policy "customers: user reads own record"
  on public.customers for select
  using (profile_id = auth.uid());

-- bookings --------------------------------------------------------------
create policy "bookings: staff full access"
  on public.bookings for all
  using (public.is_staff()) with check (public.is_staff());

create policy "bookings: customer reads own"
  on public.bookings for select
  using (
    exists (
      select 1 from public.customers c
      where c.id = bookings.customer_id
        and c.profile_id = auth.uid()
    )
  );

create policy "bookings: driver reads bookings on their jobs"
  on public.bookings for select
  using (
    exists (
      select 1
      from public.jobs j
      join public.drivers d on d.id = j.driver_id
      where j.booking_id = bookings.id
        and d.profile_id = auth.uid()
    )
  );

-- drivers -------------------------------------------------------------
create policy "drivers: staff full access"
  on public.drivers for all
  using (public.is_staff()) with check (public.is_staff());

create policy "drivers: driver reads own record"
  on public.drivers for select
  using (profile_id = auth.uid());

-- jobs ------------------------------------------------------------
create policy "jobs: staff full access"
  on public.jobs for all
  using (public.is_staff()) with check (public.is_staff());

create policy "jobs: driver reads assigned jobs"
  on public.jobs for select
  using (
    exists (
      select 1 from public.drivers d
      where d.id = jobs.driver_id
        and d.profile_id = auth.uid()
    )
  );

create policy "jobs: driver updates assigned jobs"
  on public.jobs for update
  using (
    exists (
      select 1 from public.drivers d
      where d.id = jobs.driver_id
        and d.profile_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.drivers d
      where d.id = jobs.driver_id
        and d.profile_id = auth.uid()
    )
  );

-- invoices --------------------------------------------------------
create policy "invoices: staff full access"
  on public.invoices for all
  using (public.is_staff()) with check (public.is_staff());

create policy "invoices: customer reads own"
  on public.invoices for select
  using (
    exists (
      select 1
      from public.bookings b
      join public.customers c on c.id = b.customer_id
      where b.id = invoices.booking_id
        and c.profile_id = auth.uid()
    )
  );

-- notifications_log ---------------------------------------------------
create policy "notifications_log: staff full access"
  on public.notifications_log for all
  using (public.is_staff()) with check (public.is_staff());

create policy "notifications_log: driver reads own"
  on public.notifications_log for select
  using (
    exists (
      select 1 from public.drivers d
      where d.id = notifications_log.driver_id
        and d.profile_id = auth.uid()
    )
  );

-- status_log --------------------------------------------------------
create policy "status_log: staff full access"
  on public.status_log for all
  using (public.is_staff()) with check (public.is_staff());

-- calendar_blocks --------------------------------------------------
-- Staff/owner only via RLS. Public availability checks and calendar reads go
-- through a server API using the service role (Option A), same as booking
-- creation. No anon/authenticated read policy by design.
create policy "calendar_blocks: staff full access"
  on public.calendar_blocks for all
  using (public.is_staff()) with check (public.is_staff());

-- call_transcripts -----------------------------------------------
create policy "call_transcripts: staff full access"
  on public.call_transcripts for all
  using (public.is_staff()) with check (public.is_staff());

-- =============================================================================
-- OWNER-ONLY (future reporting / config tables)
-- =============================================================================
-- Reporting and configuration tables added in later phases should enable RLS
-- and carry an owner-only policy, e.g.:
--
--   create policy "<table>: owner only"
--     on public.<table> for all
--     using (public.is_owner()) with check (public.is_owner());
--
-- `public.is_owner()` is defined above for that purpose.
