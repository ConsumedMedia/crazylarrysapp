-- =============================================================================
-- Crazy Larry's Dumpsters — log test-mode redirects truthfully
-- =============================================================================
-- With CL_NOTIFICATIONS_TEST_TO set, sendSms/sendEmail deliver to the test
-- address, but notifications_log.recipient recorded the customer's number or
-- email — a row read "sent to the customer" when the customer got nothing.
--
-- From now on `recipient` is who was actually contacted, and this column holds
-- the intended recipient whenever a test-mode redirect was applied (NULL =
-- not redirected). Additive and nullable: code that doesn't know the column
-- (production's 0a7e76b line) keeps inserting exactly as before.
-- Existing rows are left alone — which old rows were redirected can't be
-- reconstructed from the table.
-- =============================================================================

alter table public.notifications_log
  add column original_recipient text;

comment on column public.notifications_log.original_recipient is
  'Intended recipient when CL_NOTIFICATIONS_TEST_TO redirected the send; recipient then holds the test address actually used. NULL = not redirected.';
