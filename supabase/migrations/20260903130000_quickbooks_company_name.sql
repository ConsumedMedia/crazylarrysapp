-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 5 completion: QuickBooks OAuth wiring
-- =============================================================================
-- The Phase 5 payment schema (20260901140000) created quickbooks_connection and
-- quickbooks_status(). Building the real OAuth flow now needs two small things:
--
--   * pgcrypto — the token manager encrypts the refresh token at rest with
--     pgp_sym_encrypt() over a direct pg connection. Supabase ships pgcrypto but
--     it is not guaranteed to be enabled in this database yet.
--   * quickbooks_connection.company_name — the settings UI shows the connected
--     sandbox / production company name. Filled in by the callback handler after
--     a successful connect (Accounting API companyinfo call).
--
-- quickbooks_status() is replaced to return company_name alongside the existing
-- fields. Still staff-visible, still never returns tokens.
-- =============================================================================

create extension if not exists pgcrypto;

alter table public.quickbooks_connection
  add column if not exists company_name text;

-- Return type gains a column — Postgres won't CREATE OR REPLACE across that.
drop function if exists public.quickbooks_status();

create or replace function public.quickbooks_status()
returns table (
  status                  text,
  realm_id                text,
  company_name            text,
  connected_at            timestamptz,
  last_refresh_at         timestamptz,
  refresh_count           integer,
  last_error              text,
  access_token_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = '42501';
  end if;
  return query
    select c.status, c.realm_id, c.company_name, c.connected_at,
           c.last_refresh_at, c.refresh_count, c.last_error,
           c.access_token_expires_at
    from public.quickbooks_connection c
    where c.id = true;
end;
$$;

grant execute on function public.quickbooks_status() to authenticated;
