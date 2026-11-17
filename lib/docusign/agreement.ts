import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { docusignConfigured } from "./config";
import {
  createAgreementEnvelope,
  createSigningUrl,
  getAgreementEnvelope,
  voidAgreementEnvelope,
} from "./envelopes";

/**
 * Online-checkout rental agreement sessions (table agreement_sessions,
 * service-role only).
 *
 *   start   -> create (or reuse) a session + its envelope, return a one-time
 *              embedded signing URL
 *   verify  -> ONE authoritative GET to DocuSign when the signer returns; the
 *              ?event=signing_complete on the return URL is only a trigger
 *   check   -> read-only gate payAndBook runs BEFORE any card charge; the
 *              session is then consumed atomically inside create_booking
 *
 * Fail closed: if DocuSign can't be reached at verify time the session stays
 * unverified and checkout stays locked.
 */

export type AgreementCode =
  | "ok"
  | "not_configured"
  | "bad_input"
  | "rate_limited"
  | "agreement_missing"
  | "agreement_incomplete"
  | "agreement_declined"
  | "agreement_used"
  | "agreement_expired"
  | "agreement_email_mismatch"
  | "unavailable"
  | "throttled";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SESSION_TTL_MS = 2 * 24 * 60 * 60 * 1000;
/** Re-check spacing when a return arrives before DocuSign shows completed. */
const RECHECK_MIN_MS = 30 * 1000;
const MAX_CHECKS = 6;
const PER_EMAIL_PER_HOUR = 5;
const GLOBAL_PER_HOUR = 100;

export function normalizeEmail(e: string): string {
  return e.trim().toLowerCase();
}

function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function agreementReturnUrl(sessionId: string): string {
  return `${siteUrl()}/book/agreement/return?session=${encodeURIComponent(sessionId)}`;
}

interface SessionRow {
  id: string;
  envelope_id: string | null;
  signer_name: string;
  signer_email: string;
  status: string;
  completed_at: string | null;
  verified_at: string | null;
  last_checked_at: string | null;
  check_count: number;
  consumed_booking_id: string | null;
  expires_at: string;
}

const COLS =
  "id, envelope_id, signer_name, signer_email, status, completed_at, verified_at, last_checked_at, check_count, consumed_booking_id, expires_at";

async function loadSession(id: string): Promise<SessionRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await createServiceClient()
    .from("agreement_sessions")
    .select(COLS)
    .eq("id", id)
    .maybeSingle();
  return (data as SessionRow | null) ?? null;
}

/**
 * Create a session + envelope for this signer, or reuse `existingSessionId`
 * when it's still open for the same name/email (so reopening the modal doesn't
 * burn a new envelope). Returns a fresh one-time signing URL (valid 300s).
 */
export async function startAgreementSession(opts: {
  signerName: string;
  signerEmail: string;
  existingSessionId?: string | null;
}): Promise<
  | { ok: true; sessionId: string; signingUrl: string; alreadySigned?: false }
  | { ok: true; sessionId: string; signingUrl: null; alreadySigned: true }
  | { ok: false; code: AgreementCode; error: string }
> {
  if (!docusignConfigured()) {
    return { ok: false, code: "not_configured", error: "Online agreements aren't available right now — please call the yard to book." };
  }
  const name = opts.signerName.trim();
  const email = normalizeEmail(opts.signerEmail);
  if (!name || name.length > 100 || !EMAIL.test(email) || email.length > 254) {
    return { ok: false, code: "bad_input", error: "Enter your name and a valid email before signing." };
  }
  const service = createServiceClient();

  // Reuse an open session for the same signer — the one the browser still
  // holds, or else the newest open one for this name + email. This is also
  // the recovery path when the return redirect never reached us (tab closed,
  // blocked navigation): we ask DocuSign (one throttled check) before minting
  // anything new, so a customer who already signed is never stuck and never
  // gets a duplicate envelope.
  const { data: openRows } = await service
    .from("agreement_sessions")
    .select(COLS)
    .eq("signer_email", email)
    .eq("signer_name", name)
    .in("status", ["sent", "completed"])
    .is("consumed_booking_id", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(PER_EMAIL_PER_HOUR);
  const open = (openRows ?? []) as SessionRow[];
  // The browser's own session first, then newest-first.
  open.sort((a, b) => (a.id === opts.existingSessionId ? -1 : b.id === opts.existingSessionId ? 1 : 0));
  for (const o of open) {
    if (o.status === "completed" && o.verified_at) {
      return { ok: true, sessionId: o.id, signingUrl: null, alreadySigned: true };
    }
    if (o.status === "sent" && o.envelope_id) {
      const v = await verifyAgreementSession(o.id); // one throttled DocuSign GET
      if (v.ok) return { ok: true, sessionId: o.id, signingUrl: null, alreadySigned: true };
    }
  }
  const s: SessionRow | null = open.length ? await loadSession(open[0].id) : null;
  if (s && !s.consumed_booking_id && new Date(s.expires_at) > new Date()) {
    if (s.status === "sent" && s.envelope_id) {
      try {
        const signingUrl = await createSigningUrl({
          envelopeId: s.envelope_id,
          sessionId: s.id,
          signerName: s.signer_name,
          signerEmail: s.signer_email,
          returnUrl: agreementReturnUrl(s.id),
        });
        return { ok: true, sessionId: s.id, signingUrl };
      } catch (e) {
        console.error("[agreement] signing URL for existing session failed:", (e as Error).message);
        // fall through to a fresh session
      }
    }
  }

  // Abuse guard: every session costs a real envelope.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const [{ count: perEmail }, { count: global }] = await Promise.all([
    service.from("agreement_sessions").select("id", { count: "exact", head: true }).eq("signer_email", email).gte("created_at", hourAgo),
    service.from("agreement_sessions").select("id", { count: "exact", head: true }).gte("created_at", hourAgo),
  ]);
  if ((perEmail ?? 0) >= PER_EMAIL_PER_HOUR || (global ?? 0) >= GLOBAL_PER_HOUR) {
    return { ok: false, code: "rate_limited", error: "Too many agreement attempts — please wait a bit or call the yard." };
  }

  const { data: created, error: insErr } = await service
    .from("agreement_sessions")
    .insert({ signer_name: name, signer_email: email, expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() })
    .select("id")
    .single();
  if (insErr || !created) {
    console.error("[agreement] session insert failed:", insErr?.message);
    return { ok: false, code: "unavailable", error: "Couldn't start the agreement. Please try again." };
  }
  const sessionId = created.id as string;

  try {
    const { envelopeId } = await createAgreementEnvelope({ sessionId, signerName: name, signerEmail: email });
    await service
      .from("agreement_sessions")
      .update({ envelope_id: envelopeId, status: "sent", updated_at: new Date().toISOString() })
      .eq("id", sessionId);
    const signingUrl = await createSigningUrl({
      envelopeId,
      sessionId,
      signerName: name,
      signerEmail: email,
      returnUrl: agreementReturnUrl(sessionId),
    });
    return { ok: true, sessionId, signingUrl };
  } catch (e) {
    console.error("[agreement] envelope/signing URL failed:", (e as Error).message);
    await service.from("agreement_sessions").update({ status: "error", updated_at: new Date().toISOString() }).eq("id", sessionId);
    return { ok: false, code: "unavailable", error: "DocuSign isn't responding right now. Please try again in a few minutes or call the yard." };
  }
}

/**
 * Confirm completion directly with DocuSign. Called when the signer returns
 * (the return URL alone proves nothing). Idempotent: a verified session never
 * calls DocuSign again. Fails closed.
 */
export async function verifyAgreementSession(sessionId: string): Promise<{
  ok: boolean;
  code: AgreementCode;
  error?: string;
  signerEmail?: string;
}> {
  const s = await loadSession(sessionId);
  if (!s || !s.envelope_id) return { ok: false, code: "agreement_missing", error: "We couldn't find that agreement. Please sign again." };
  if (s.status === "completed" && s.verified_at) return { ok: true, code: "ok", signerEmail: s.signer_email };
  if (["declined", "voided", "expired"].includes(s.status)) {
    return { ok: false, code: s.status === "declined" ? "agreement_declined" : "agreement_expired", error: "That agreement can't be used any more. Please sign again." };
  }
  if (s.check_count >= MAX_CHECKS) {
    return { ok: false, code: "throttled", error: "We still can't confirm your signature. Please call the yard." };
  }
  if (s.last_checked_at && Date.now() - new Date(s.last_checked_at).getTime() < RECHECK_MIN_MS) {
    return { ok: false, code: "throttled", error: "Still confirming your signature — try again in a few seconds." };
  }

  const service = createServiceClient();
  const now = new Date().toISOString();
  await service
    .from("agreement_sessions")
    .update({ last_checked_at: now, check_count: s.check_count + 1, updated_at: now })
    .eq("id", s.id);

  let env;
  try {
    env = await getAgreementEnvelope(s.envelope_id);
  } catch (e) {
    console.error("[agreement] verify: DocuSign unreachable:", (e as Error).message);
    return { ok: false, code: "unavailable", error: "We can't confirm your agreement with DocuSign right now. Please try again shortly, or call the yard to book by phone." };
  }

  // The envelope must be ours and signed by the session's signer.
  const signerOk =
    env.signer !== null &&
    normalizeEmail(env.signer.email) === s.signer_email &&
    env.signer.clientUserId === s.id &&
    env.sessionField === s.id;

  if (env.status === "completed" && signerOk) {
    await service
      .from("agreement_sessions")
      .update({ status: "completed", completed_at: env.completedAt ?? now, verified_at: now, updated_at: now })
      .eq("id", s.id);
    // Keep our own copy now, while the envelope certainly exists. Never
    // blocks the customer: a failure is recorded and retried daily.
    await archiveAgreementDocument(s.id);
    return { ok: true, code: "ok", signerEmail: s.signer_email };
  }
  if (env.status === "completed" && !signerOk) {
    console.error(`[agreement] verify: envelope ${s.envelope_id} completed but signer/session mismatch`);
    await service.from("agreement_sessions").update({ status: "error", updated_at: now }).eq("id", s.id);
    return { ok: false, code: "agreement_email_mismatch", error: "That agreement doesn't match this booking. Please sign again." };
  }
  if (env.status === "declined" || env.status === "voided") {
    await service.from("agreement_sessions").update({ status: env.status, updated_at: now }).eq("id", s.id);
    return { ok: false, code: env.status === "declined" ? "agreement_declined" : "agreement_expired", error: "The agreement wasn't signed. Please sign again to continue." };
  }
  return { ok: false, code: "agreement_incomplete", error: "DocuSign doesn't show the agreement as signed yet." };
}

/**
 * The checkout gate — read-only, NO DocuSign call, runs before any card
 * charge. create_booking re-checks the same rules under its lock and
 * consumes the session atomically.
 */
export async function checkAgreementForCheckout(
  sessionId: string | null | undefined,
  contactEmail: string | null | undefined,
): Promise<{ ok: true } | { ok: false; code: AgreementCode; error: string }> {
  if (!sessionId) {
    return { ok: false, code: "agreement_missing", error: "Please sign the rental agreement first." };
  }
  const s = await loadSession(sessionId);
  if (!s) return { ok: false, code: "agreement_missing", error: "Please sign the rental agreement first." };
  if (s.status !== "completed" || !s.verified_at) {
    return { ok: false, code: "agreement_incomplete", error: "Your rental agreement isn't signed yet." };
  }
  if (s.consumed_booking_id) {
    return { ok: false, code: "agreement_used", error: "That agreement was already used for a booking. Please sign a new one." };
  }
  if (new Date(s.expires_at) <= new Date()) {
    return { ok: false, code: "agreement_expired", error: "Your agreement session expired. Please sign again." };
  }
  if (!contactEmail || normalizeEmail(contactEmail) !== s.signer_email) {
    return { ok: false, code: "agreement_email_mismatch", error: "The agreement was signed with a different email than this booking. Please sign again with this email." };
  }
  return { ok: true };
}

/**
 * Daily: void unsigned envelopes whose sessions are past their 2-day window
 * (DocuSign also expires them at 2 days; voiding closes them out explicitly
 * and marks our rows). Never touches completed envelopes.
 */
export async function voidAbandonedAgreements(): Promise<{ checked: number; voided: number; errors: string[] }> {
  if (!docusignConfigured()) return { checked: 0, voided: 0, errors: [] };
  const service = createServiceClient();
  const { data } = await service
    .from("agreement_sessions")
    .select("id, envelope_id, status")
    .in("status", ["created", "sent"])
    .lt("expires_at", new Date().toISOString())
    .limit(100);
  const errors: string[] = [];
  let voided = 0;
  for (const s of data ?? []) {
    const now = new Date().toISOString();
    if (!s.envelope_id) {
      await service.from("agreement_sessions").update({ status: "expired", updated_at: now }).eq("id", s.id);
      continue;
    }
    // The return redirect may never have reached us (tab closed, blocked
    // navigation) even though the customer DID sign. Ask DocuSign first
    // (normal throttled verify); a completed envelope is verified + archived
    // instead of voided, and the 30-day unbooked rule then applies to it.
    const v = await verifyAgreementSession(s.id as string);
    if (v.ok) continue;
    try {
      await voidAgreementEnvelope(s.envelope_id as string, "Abandoned online checkout — agreement not signed within 2 days");
      await service.from("agreement_sessions").update({ status: "voided", updated_at: now }).eq("id", s.id);
      voided++;
    } catch (e) {
      const msg = (e as Error).message;
      // Already expired/voided on DocuSign's side is fine — close ours out.
      if (/ENVELOPE_CANNOT_VOID|ENVELOPE_IS_INCOMPLETE|voided|expired/i.test(msg)) {
        await service.from("agreement_sessions").update({ status: "expired", updated_at: now }).eq("id", s.id);
      } else {
        errors.push(`${s.id}: ${msg}`);
      }
    }
  }
  return { checked: (data ?? []).length, voided, errors };
}

// ---------------------------------------------------------------------------
// Signed-agreement archive (bucket 'signed-agreements', migration 20261001000000)
// ---------------------------------------------------------------------------

export const AGREEMENT_BUCKET = "signed-agreements";
const UNBOOKED_RETENTION_DAYS = 30;

export function agreementDocumentPath(sessionId: string): string {
  return `${sessionId}/signed-agreement.pdf`;
}

/**
 * Download the completed envelope's combined PDF (documents + Certificate of
 * Completion) and store our own copy. Service-role write — staff can only
 * read the bucket. Idempotent: an already-stored copy is left alone. Never
 * throws; failures land in document_error for the daily retry.
 */
export async function archiveAgreementDocument(sessionId: string): Promise<{ ok: boolean; error?: string }> {
  const service = createServiceClient();
  const s = await loadSession(sessionId);
  if (!s || !s.envelope_id || s.status !== "completed") return { ok: false, error: "not a completed session" };
  const { data: existing } = await service
    .from("agreement_sessions")
    .select("document_path")
    .eq("id", sessionId)
    .single();
  if (existing?.document_path) return { ok: true };

  const now = new Date().toISOString();
  try {
    const { downloadSignedAgreementPdf } = await import("./envelopes");
    const pdf = await downloadSignedAgreementPdf(s.envelope_id);
    if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new Error("DocuSign did not return a PDF");
    }
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(pdf).digest("hex");
    const path = agreementDocumentPath(sessionId);
    const { error: upErr } = await service.storage
      .from(AGREEMENT_BUCKET)
      .upload(path, pdf, { contentType: "application/pdf", upsert: false });
    if (upErr && !/exists|duplicate/i.test(upErr.message)) throw new Error(`storage: ${upErr.message}`);
    await service
      .from("agreement_sessions")
      .update({
        document_path: path,
        document_sha256: sha256,
        document_bytes: pdf.length,
        document_stored_at: now,
        document_error: null,
        updated_at: now,
      })
      .eq("id", sessionId);
    return { ok: true };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    console.error(`[agreement] archive failed for ${sessionId}:`, msg);
    await service.from("agreement_sessions").update({ document_error: msg, updated_at: now }).eq("id", sessionId);
    return { ok: false, error: msg };
  }
}

/** Daily: retry archiving any verified agreement without a stored copy. */
export async function retryAgreementArchives(): Promise<{ checked: number; stored: number; errors: string[] }> {
  if (!docusignConfigured()) return { checked: 0, stored: 0, errors: [] };
  const { data } = await createServiceClient()
    .from("agreement_sessions")
    .select("id")
    .eq("status", "completed")
    .not("verified_at", "is", null)
    .is("document_path", null)
    .limit(25);
  let stored = 0;
  const errors: string[] = [];
  for (const row of data ?? []) {
    const r = await archiveAgreementDocument(row.id as string);
    if (r.ok) stored++;
    else errors.push(`${row.id}: ${r.error}`);
  }
  return { checked: (data ?? []).length, stored, errors };
}

/**
 * Daily: signed agreements that never became a booking are deleted after 30
 * days — DocuSign purge requested, our PDF removed, session row deleted.
 * Agreements attached to a booking are never touched (no automatic deletion).
 */
export async function deleteUnbookedSignedAgreements(): Promise<{ checked: number; deleted: number; errors: string[] }> {
  const service = createServiceClient();
  const cutoff = new Date(Date.now() - UNBOOKED_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await service
    .from("agreement_sessions")
    .select("id, envelope_id, document_path")
    .eq("status", "completed")
    .is("consumed_booking_id", null)
    .lt("verified_at", cutoff)
    .limit(50);
  let deleted = 0;
  const errors: string[] = [];
  for (const s of data ?? []) {
    try {
      if (s.envelope_id && docusignConfigured()) {
        try {
          const { requestAgreementEnvelopePurge } = await import("./envelopes");
          await requestAgreementEnvelopePurge(s.envelope_id as string);
        } catch (e) {
          // Sandbox envelopes may already be gone (30-day developer
          // retention); anything else is reported but doesn't keep the row.
          errors.push(`${s.id}: DocuSign purge request: ${(e as Error).message}`);
        }
      }
      if (s.document_path) {
        const { error } = await service.storage.from(AGREEMENT_BUCKET).remove([s.document_path as string]);
        if (error) throw new Error(`storage remove: ${error.message}`);
      }
      // Re-check under the delete: never remove a session that got consumed meanwhile.
      const { error: delErr } = await service
        .from("agreement_sessions")
        .delete()
        .eq("id", s.id)
        .is("consumed_booking_id", null);
      if (delErr) throw new Error(delErr.message);
      deleted++;
    } catch (e) {
      errors.push(`${s.id}: ${(e as Error).message}`);
    }
  }
  return { checked: (data ?? []).length, deleted, errors };
}

/**
 * Staff view: short-lived signed URL for a booking's stored agreement,
 * created with the STAFF member's own session so the bucket's is_staff()
 * policy is an independent check. Returns null when there's no stored copy.
 */
export async function signedAgreementInfo(bookingId: string): Promise<{
  sessionId: string;
  envelopeId: string | null;
  documentPath: string | null;
  storedAt: string | null;
  error: string | null;
} | null> {
  const { data } = await createServiceClient()
    .from("agreement_sessions")
    .select("id, envelope_id, document_path, document_stored_at, document_error")
    .eq("consumed_booking_id", bookingId)
    .maybeSingle();
  if (!data) return null;
  return {
    sessionId: data.id as string,
    envelopeId: (data.envelope_id as string | null) ?? null,
    documentPath: (data.document_path as string | null) ?? null,
    storedAt: (data.document_stored_at as string | null) ?? null,
    error: (data.document_error as string | null) ?? null,
  };
}
