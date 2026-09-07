-- =============================================================================
-- Crazy Larry's Dumpsters — deployed-unit map: cache geocoded coordinates
-- =============================================================================
-- Geocoded once per booking, lazily, the first time the fleet map needs a
-- pin for it (see lib/fleet/map.ts) — never on every page load. Nullable:
-- most bookings never need a pin (only ones that reach 'deployed'), and a
-- failed geocode just leaves these null rather than blocking anything.
alter table public.bookings
  add column if not exists delivery_lat double precision,
  add column if not exists delivery_lng double precision;
