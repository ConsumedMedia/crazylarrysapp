-- =============================================================================
-- Crazy Larry's Dumpsters — lock service-only RPCs back down to service_role
-- =============================================================================
-- Found 2026-09-23 while planning admin manual bookings. Postgres grants
-- EXECUTE on every new function to PUBLIC by default, and Supabase's default
-- privileges additionally grant anon + authenticated. The migrations that
-- created the functions below only ever *granted* to service_role — they never
-- revoked the defaults — so every one of them was callable by anyone holding
-- the public anon key, straight through PostgREST (/rest/v1/rpc/<name>).
--
-- All seven are SECURITY DEFINER with no is_staff() guard, because their only
-- intended caller is server code using the service-role client. Verified
-- exploitable before this fix: an anon POST to /rpc/record_payment reached the
-- function body (failed only on the invoices->bookings FK because the probe
-- used a nonexistent booking id — a real id would have been marked paid).
--
-- Every call site (lib/bookings/{checkout,create}.ts, lib/quickbooks/invoices.ts,
-- lib/cron/jobs.ts, scripts/seed-demo.mjs) uses the service-role client, so
-- revoking from anon/authenticated changes nothing for the app.
--
-- Also drops the stale 11-arg create_booking overload: 20260921000000 added
-- p_sms_consent via CREATE OR REPLACE with a new arity, which created a second
-- function instead of replacing the first. Nothing calls the old one (the
-- 12-arg version's p_sms_consent has a default, so 11-arg-shaped calls resolve
-- to it once the old overload is gone).
-- =============================================================================

drop function if exists public.create_booking(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text, uuid
);

revoke execute on function public.create_booking(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text, uuid, boolean
) from public, anon, authenticated;
revoke execute on function public.record_payment(uuid, text, text, numeric)
  from public, anon, authenticated;
revoke execute on function public.record_invoice_synced(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.record_payment_attempt(text, text, text, numeric, text, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.mark_overdue_bookings()
  from public, anon, authenticated;
revoke execute on function public.quickbooks_force_expire()
  from public, anon, authenticated;

grant execute on function public.create_booking(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text, uuid, boolean
) to service_role;
grant execute on function public.record_payment(uuid, text, text, numeric) to service_role;
grant execute on function public.record_invoice_synced(uuid, text) to service_role;
grant execute on function public.record_payment_attempt(text, text, text, numeric, text, text, jsonb) to service_role;
grant execute on function public.mark_overdue_bookings() to service_role;
grant execute on function public.quickbooks_force_expire() to service_role;
