-- =============================================================================
-- Crazy Larry's Dumpsters — driveway protection fee
-- =============================================================================
-- Real feature, not a settings-only field: staff decide per booking whether to
-- apply it (never automatic, never customer-selected). It deliberately never
-- touches bookings.subtotal/tax/total — those stay the authoritative "what was
-- actually charged via card" record, matching invoices.amount forever, because
-- create_booking charges the card in the same request it creates the booking
-- (no card is ever kept on file), so there is no way for this app to
-- automatically re-charge a customer after the fact.
--
-- Instead this is tracked as its own fact on the booking (amount snapshotted
-- at apply time, same reasoning as base_price -> bookings.subtotal, so a later
-- rate change never rewrites history) and billed to the customer as a second,
-- separate QuickBooks Invoice (unpaid/AR) — the same thing the office would
-- create manually today. The original booking invoice is never touched; it's
-- a one-shot idempotent sync with no update path (see syncInvoiceForBooking).
--
-- Un-applying voids that second QBO invoice (lib/quickbooks/driveway-fee.ts),
-- same void-before-refund shape as the existing refund flow.
--
-- Tracking is plain columns on bookings, not a ledger table — this is a single
-- point-in-time fact per booking (applied or not), same shape as how refunds
-- already live as columns on invoices (refund_kind/refunded_amount/refunded_at)
-- rather than their own table.
-- =============================================================================

alter table public.cl_pricing_settings
  add column driveway_fee_rate numeric(10, 2) not null default 20 check (driveway_fee_rate >= 0);

alter table public.bookings
  add column driveway_fee_applied       boolean not null default false,
  add column driveway_fee_amount        numeric(10, 2),
  add column driveway_fee_applied_by    uuid references public.profiles (id) on delete set null,
  add column driveway_fee_applied_at    timestamptz,
  add column driveway_fee_note          text,
  add column driveway_fee_qb_invoice_id text;

-- -----------------------------------------------------------------------------
-- apply_driveway_fee — staff-only, security invoker (mirrors record_refund).
-- Writes the flag/amount/who/when/note. The Node layer calls this FIRST, then
-- creates the QBO invoice; if that fails, it calls remove_driveway_fee to roll
-- this back so staff never see a half-applied state (mirrors checkout.ts's
-- compensating-refund-on-create_booking-failure pattern).
-- -----------------------------------------------------------------------------
create or replace function public.apply_driveway_fee(
  p_booking_id uuid,
  p_amount     numeric,
  p_note       text default null
)
returns public.bookings
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.bookings;
begin
  if not public.is_staff() then
    raise exception 'Only staff or owner may apply the driveway fee'
      using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive' using errcode = '22003';
  end if;

  update public.bookings set
    driveway_fee_applied    = true,
    driveway_fee_amount     = p_amount,
    driveway_fee_applied_by = auth.uid(),
    driveway_fee_applied_at = now(),
    driveway_fee_note       = p_note,
    -- qb invoice id is filled in by record_driveway_fee_invoice once Node
    -- creates it; a fresh apply always starts clean.
    driveway_fee_qb_invoice_id = null
  where id = p_booking_id
    and driveway_fee_applied = false
  returning * into v_row;

  if not found then
    if exists (select 1 from public.bookings where id = p_booking_id) then
      raise exception 'Driveway fee is already applied to this booking'
        using errcode = '23514';
    end if;
    raise exception 'Booking % not found', p_booking_id using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

-- record_driveway_fee_invoice ------------------------------------------------
-- Follow-up write once the QBO invoice actually exists (same split as
-- record_payment / record_invoice_synced).
create or replace function public.record_driveway_fee_invoice(
  p_booking_id    uuid,
  p_qb_invoice_id text
)
returns public.bookings
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.bookings;
begin
  if not public.is_staff() then
    raise exception 'Only staff or owner may record the driveway fee invoice'
      using errcode = '42501';
  end if;

  update public.bookings
    set driveway_fee_qb_invoice_id = p_qb_invoice_id
    where id = p_booking_id
    returning * into v_row;

  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

-- remove_driveway_fee ---------------------------------------------------
-- Un-apply. Node voids the QBO invoice (if one was ever recorded) BEFORE
-- calling this, same order as refundBooking voids/refunds in QB before
-- writing the DB row. Also used as the compensating rollback if QBO invoice
-- creation itself fails right after apply_driveway_fee.
create or replace function public.remove_driveway_fee(
  p_booking_id uuid
)
returns public.bookings
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.bookings;
begin
  if not public.is_staff() then
    raise exception 'Only staff or owner may remove the driveway fee'
      using errcode = '42501';
  end if;

  update public.bookings set
    driveway_fee_applied       = false,
    driveway_fee_amount        = null,
    driveway_fee_applied_by    = null,
    driveway_fee_applied_at    = null,
    driveway_fee_note          = null,
    driveway_fee_qb_invoice_id = null
  where id = p_booking_id
  returning * into v_row;

  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

grant execute on function public.apply_driveway_fee(uuid, numeric, text) to authenticated;
grant execute on function public.record_driveway_fee_invoice(uuid, text) to authenticated;
grant execute on function public.remove_driveway_fee(uuid) to authenticated;
