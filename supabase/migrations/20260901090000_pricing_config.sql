-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 4: pricing configuration
-- =============================================================================
-- Rates are NOT known yet. These tables are seeded structurally empty — every
-- rate is 0 and cl_pricing.is_active is false. create_booking refuses to create
-- a booking for a size until staff enter a real base_price and mark it active,
-- and until a tax_rate > 0 is set (see 20260901100000).
--
-- Owner writes, staff reads (config table — Phase 1 owner/config decision).

-- Per-size base rate for the standard rental (included_days on site,
-- included_tons of weight). Overage is billed later, post-weigh (Phase 5).
create table public.cl_pricing (
  size          public.dumpster_size primary key,
  base_price    numeric(10, 2) not null default 0 check (base_price >= 0),
  included_days integer        not null default 5 check (included_days > 0),
  included_tons numeric(4, 1)  not null default 1.0 check (included_tons > 0),
  is_active     boolean        not null default false,
  updated_at    timestamptz    not null default now(),
  updated_by    uuid references public.profiles (id) on delete set null
);

create trigger cl_pricing_set_updated_at
  before update on public.cl_pricing
  for each row execute function public.set_updated_at();

-- Global pricing settings — single row (id is always true).
create table public.cl_pricing_settings (
  id                boolean primary key default true check (id),
  extra_day_rate    numeric(10, 2) not null default 0 check (extra_day_rate >= 0),
  overage_ton_rate  numeric(10, 2) not null default 0 check (overage_ton_rate >= 0),
  -- Sales tax as a fraction, e.g. 0.0750. Ohio sales tax varies by county /
  -- municipality; tax_verified tracks whether this figure was checked against
  -- the actual delivery jurisdiction rather than taken on the owner's word.
  tax_rate          numeric(6, 4)  not null default 0 check (tax_rate >= 0 and tax_rate < 1),
  tax_jurisdiction  text,
  tax_verified      boolean        not null default false,
  tax_verified_note text,
  updated_at        timestamptz    not null default now(),
  updated_by        uuid references public.profiles (id) on delete set null
);

create trigger cl_pricing_settings_set_updated_at
  before update on public.cl_pricing_settings
  for each row execute function public.set_updated_at();

-- Structural seed only — placeholder zero rates, inactive.
insert into public.cl_pricing (size) values ('10yd'), ('15yd'), ('20yd')
on conflict (size) do nothing;

insert into public.cl_pricing_settings (id) values (true)
on conflict (id) do nothing;

-- =============================================================================
-- RLS — staff read, owner write
-- =============================================================================
alter table public.cl_pricing          enable row level security;
alter table public.cl_pricing_settings enable row level security;

create policy "cl_pricing: staff read"
  on public.cl_pricing for select
  using (public.is_staff());

create policy "cl_pricing: owner write"
  on public.cl_pricing for all
  using (public.is_owner()) with check (public.is_owner());

create policy "cl_pricing_settings: staff read"
  on public.cl_pricing_settings for select
  using (public.is_staff());

create policy "cl_pricing_settings: owner write"
  on public.cl_pricing_settings for all
  using (public.is_owner()) with check (public.is_owner());
