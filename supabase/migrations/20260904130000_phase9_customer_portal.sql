-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 9: Customer Portal
--   1. claim_guest_bookings() — links a newly-authenticated customer's
--      verified email to any pre-existing guest `customers` row
--   2. booking_change_requests — customer-submitted change requests that
--      route to staff for approval (never mutate bookings directly)
-- =============================================================================

-- =============================================================================
-- 1. GUEST BOOKING LINKING
-- =============================================================================
-- SECURITY DEFINER so it can read auth.users.email for the caller — the
-- client never supplies an email here, so this can't be used to claim a
-- stranger's bookings. It only ever links using the email Supabase Auth has
-- already verified belongs to the calling session (auth.uid()). Safe to call
-- on every login / account-page load: it's a no-op once nothing matches.
create or replace function public.claim_guest_bookings()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email  text;
  v_linked integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select email into v_email from auth.users where id = auth.uid();
  if v_email is null then
    return 0;
  end if;

  update public.customers
  set profile_id = auth.uid()
  where profile_id is null
    and lower(email) = lower(v_email);

  get diagnostics v_linked = row_count;
  return v_linked;
end;
$$;

grant execute on function public.claim_guest_bookings() to authenticated;

-- =============================================================================
-- 2. BOOKING CHANGE REQUESTS
-- =============================================================================
create type public.change_request_status as enum (
  'pending', 'approved', 'declined', 'cancelled'
);

create table public.booking_change_requests (
  id                       uuid primary key default gen_random_uuid(),
  booking_id               uuid not null references public.bookings (id) on delete restrict,
  requested_by             uuid not null references public.profiles (id) on delete restrict,
  requested_delivery_date  date,
  requested_pickup_date    date,
  reason                   text not null,
  status                   public.change_request_status not null default 'pending',
  staff_response           text,
  resolved_by              uuid references public.profiles (id) on delete set null,
  resolved_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint booking_change_requests_has_change_ck check (
    requested_delivery_date is not null or requested_pickup_date is not null
  )
);

create index booking_change_requests_booking_id_idx on public.booking_change_requests (booking_id);
create index booking_change_requests_status_idx on public.booking_change_requests (status);
create index booking_change_requests_requested_by_idx on public.booking_change_requests (requested_by);

create trigger booking_change_requests_set_updated_at
  before update on public.booking_change_requests
  for each row execute function public.set_updated_at();

alter table public.booking_change_requests enable row level security;

create policy "booking_change_requests: staff full access"
  on public.booking_change_requests for all
  using (public.is_staff()) with check (public.is_staff());

create policy "booking_change_requests: customer creates own"
  on public.booking_change_requests for insert
  with check (
    requested_by = auth.uid()
    and exists (
      select 1
      from public.bookings b
      join public.customers c on c.id = b.customer_id
      where b.id = booking_change_requests.booking_id
        and c.profile_id = auth.uid()
    )
  );

create policy "booking_change_requests: customer reads own"
  on public.booking_change_requests for select
  using (
    exists (
      select 1
      from public.bookings b
      join public.customers c on c.id = b.customer_id
      where b.id = booking_change_requests.booking_id
        and c.profile_id = auth.uid()
    )
  );

-- Customer can withdraw their own still-pending request. The `with check`
-- pins the resulting status to 'cancelled' — this policy cannot be used to
-- self-approve or otherwise move a request into any other state.
create policy "booking_change_requests: customer cancels own pending"
  on public.booking_change_requests for update
  using (requested_by = auth.uid() and status = 'pending')
  with check (requested_by = auth.uid() and status = 'cancelled');
