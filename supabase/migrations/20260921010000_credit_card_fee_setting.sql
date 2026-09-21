-- =============================================================================
-- Crazy Larry's Dumpsters — credit card fee rate (accounting reference only)
-- =============================================================================
-- Larry wants to track what the card processor takes as a percentage, purely
-- for his own bookkeeping. Same shape as tax_rate (a fraction, e.g. 0.0290 for
-- 2.90%) but deliberately NOT read by booking_quote or anything that touches
-- a customer's total — it is never added to what a customer is charged.
-- =============================================================================

alter table public.cl_pricing_settings
  add column credit_card_fee_rate numeric(6, 4) not null default 0
    check (credit_card_fee_rate >= 0 and credit_card_fee_rate < 1);
