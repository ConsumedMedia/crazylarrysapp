import "server-only";
import { getDocusignConfig } from "./config";
import { docusignBinary, docusignJson } from "./client";

/**
 * Agreement envelopes for the online checkout.
 *
 * We create each envelope ourselves (from the PowerForm's template) instead
 * of letting the customer submit the PowerForm, so the server knows the
 * envelope id from the moment it exists and sets the signer's name/email
 * itself. The Renter is an EMBEDDED recipient (clientUserId = our
 * agreement_sessions.id): DocuSign doesn't email them a signing link; we hand
 * them a one-time recipient-view URL instead.
 */

export const AGREEMENT_ROLE = "Renter";
export const SESSION_CUSTOM_FIELD = "cl_agreement_session";
/** Unsigned agreement envelopes expire after this many days (DocuSign-side). */
export const ENVELOPE_EXPIRE_DAYS = 2;

let templateIdCache: string | null = null;

/** The agreement template behind DOCUSIGN_POWERFORM_ID (cached per instance). */
export async function getAgreementTemplateId(): Promise<string> {
  if (templateIdCache) return templateIdCache;
  const { powerFormId } = getDocusignConfig();
  const pf = await docusignJson<{ templateId?: string }>(`powerforms/${powerFormId}`);
  if (!pf.templateId) throw new Error("DocuSign PowerForm has no templateId");
  templateIdCache = pf.templateId;
  return templateIdCache;
}

export async function createAgreementEnvelope(opts: {
  sessionId: string;
  signerName: string;
  signerEmail: string;
}): Promise<{ envelopeId: string }> {
  const templateId = await getAgreementTemplateId();
  const res = await docusignJson<{ envelopeId: string; status: string }>("envelopes", {
    method: "POST",
    body: JSON.stringify({
      templateId,
      status: "sent",
      emailSubject: "Crazy Larry's Dumpsters — rental agreement",
      templateRoles: [
        {
          roleName: AGREEMENT_ROLE,
          name: opts.signerName,
          email: opts.signerEmail,
          clientUserId: opts.sessionId,
        },
      ],
      customFields: {
        textCustomFields: [
          { name: SESSION_CUSTOM_FIELD, value: opts.sessionId, show: "false", required: "false" },
        ],
      },
      notification: {
        useAccountDefaults: "false",
        expirations: {
          expireEnabled: "true",
          expireAfter: String(ENVELOPE_EXPIRE_DAYS),
          expireWarn: "0",
        },
      },
    }),
  });
  return { envelopeId: res.envelopeId };
}

/** One-time signing URL (valid 300s). Only works while the envelope is `sent`. */
export async function createSigningUrl(opts: {
  envelopeId: string;
  sessionId: string;
  signerName: string;
  signerEmail: string;
  returnUrl: string;
}): Promise<string> {
  const res = await docusignJson<{ url: string }>(`envelopes/${opts.envelopeId}/views/recipient`, {
    method: "POST",
    body: JSON.stringify({
      returnUrl: opts.returnUrl,
      authenticationMethod: "none",
      userName: opts.signerName,
      email: opts.signerEmail,
      clientUserId: opts.sessionId,
    }),
  });
  return res.url;
}

export interface AgreementEnvelopeState {
  status: string; // sent | delivered | completed | declined | voided | ...
  completedAt: string | null;
  signer: { email: string; name: string; clientUserId: string | null; status: string } | null;
  sessionField: string | null;
}

/** Authoritative envelope state straight from DocuSign (one GET). */
export async function getAgreementEnvelope(envelopeId: string): Promise<AgreementEnvelopeState> {
  const env = await docusignJson<{
    status: string;
    completedDateTime?: string;
    recipients?: { signers?: Array<{ email: string; name: string; clientUserId?: string; status: string; roleName?: string }> };
    customFields?: { textCustomFields?: Array<{ name: string; value: string }> };
  }>(`envelopes/${envelopeId}?include=recipients,custom_fields`);
  const signer =
    env.recipients?.signers?.find((s) => s.roleName === AGREEMENT_ROLE) ??
    env.recipients?.signers?.[0] ??
    null;
  return {
    status: env.status,
    completedAt: env.completedDateTime ?? null,
    signer: signer
      ? { email: signer.email, name: signer.name, clientUserId: signer.clientUserId ?? null, status: signer.status }
      : null,
    sessionField:
      env.customFields?.textCustomFields?.find((f) => f.name === SESSION_CUSTOM_FIELD)?.value ?? null,
  };
}

/**
 * The completed agreement as one PDF: every document plus DocuSign's
 * Certificate of Completion (the signing audit trail). One GET per envelope —
 * called once, when we archive it.
 */
export async function downloadSignedAgreementPdf(envelopeId: string): Promise<Buffer> {
  return docusignBinary(`envelopes/${envelopeId}/documents/combined?certificate=true`);
}

/**
 * Ask DocuSign to purge an envelope's documents and metadata (used for signed
 * agreements that never became a booking). DocuSign processes purges from a
 * queue, not immediately.
 */
export async function requestAgreementEnvelopePurge(envelopeId: string): Promise<void> {
  await docusignJson(`envelopes/${envelopeId}`, {
    method: "PUT",
    body: JSON.stringify({ purgeState: "documents_and_metadata_queued" }),
  });
}

export async function voidAgreementEnvelope(envelopeId: string, reason: string): Promise<void> {
  await docusignJson(`envelopes/${envelopeId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "voided", voidedReason: reason }),
  });
}
