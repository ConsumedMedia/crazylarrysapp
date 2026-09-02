-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 4: enum additions
-- =============================================================================
-- These ALTER TYPE ... ADD VALUE statements must land in their own migration:
-- Postgres lets a new enum value be declared inside a transaction but forbids
-- USING it in that same transaction. The booking engine migration
-- (20260901100000) uses both values, so they are added here first.
--
--  * job_status += 'cancelled'      — a booking cancellation cascades to its
--                                     non-completed delivery/pickup jobs.
--  * status_log_entity += 'job'     — those job status changes are written to
--                                     status_log, same as dumpster/booking.

alter type public.job_status add value if not exists 'cancelled';

alter type public.status_log_entity add value if not exists 'job';
