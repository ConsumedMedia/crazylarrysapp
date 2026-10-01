-- =============================================================================
-- Crazy Larry's Dumpsters — keep our own copy of each signed rental agreement
-- =============================================================================
-- When verifyAgreementSession() confirms an envelope is completed with
-- DocuSign, the server also downloads the combined signed PDF (documents +
-- Certificate of Completion) and stores it in a private Storage bucket. Staff
-- open it from the booking page through a short-lived signed URL.
--
-- Why our own copy instead of fetching from DocuSign on every view:
--   * DocuSign's developer environment removes envelopes after 30 days, and in
--     production any account admin can enable a document-retention policy that
--     purges completed envelopes (documents AND metadata) — outside our control.
--   * DocuSign's API rules forbid GETting the same URL more than once per 15
--     minutes; staff re-opening a document would break that.
--   * Views keep working when DocuSign is down or credentials change.
--
-- Retention (decided 2026-10-01): copies for BOOKED agreements are kept with no
-- automatic deletion (6-year Ohio written-contract limitation noted as a
-- reference only, pending Larry/accountant). Signed agreements that never
-- became a booking are deleted after 30 days by the daily cron — our PDF, the
-- session row, and a purge request for the DocuSign envelope.
--
-- Pattern: same as job-photos (20260907000000) — private bucket, storage.objects
-- policies gated by public.is_staff(), signed URLs generated server-side —
-- with one deliberate difference: staff get READ ONLY. A signed contract is an
-- immutable record, so only the service role (server code) can write it; there
-- is no staff insert/update/delete policy.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Bucket — private, PDFs only, size-capped
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('signed-agreements', 'signed-agreements', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

-- Path convention: <agreement_session_id>/signed-agreement.pdf
create policy "signed-agreements: staff read"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'signed-agreements' and public.is_staff());
-- Intentionally no insert/update/delete policies: writes are service-role only.

-- -----------------------------------------------------------------------------
-- 2. Where the copy is recorded — on the agreement session (which links to the
--    booking via consumed_booking_id). agreement_sessions stays service-role
--    only (RLS on, no grants), so staff never read these columns directly;
--    the booking page reads them server-side after requireStaff().
-- -----------------------------------------------------------------------------
alter table public.agreement_sessions
  add column document_path      text,          -- object path in 'signed-agreements'
  add column document_sha256    text,          -- integrity check of the stored PDF
  add column document_bytes     integer,
  add column document_stored_at timestamptz,
  add column document_error     text;          -- last archival failure (retried daily)

create index agreement_sessions_doc_pending_idx on public.agreement_sessions (verified_at)
  where status = 'completed' and document_path is null;
