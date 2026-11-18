/**
 * The rental-agreement switch, pure part (docusign-port, task 4). Two keys:
 *
 *   capability  per deployment (env): CL_DOCUSIGN_ENABLED=1 AND every
 *               DOCUSIGN_* variable. Preview can have it while Production
 *               doesn't.
 *   setting     the owner's mode in the shared database
 *               (cl_agreement_settings.mode): attest or docusign.
 *
 * DocuSign only when BOTH say so. Anything else (setting attest, setting
 * unreadable, capability missing) is attest: exactly the PowerForm-and-
 * checkbox /book that users-page shipped. Preview and Production share one
 * database, so the setting alone can never switch a deployment.
 */

export type AgreementMode = "attest" | "docusign";

export interface DocusignCapability {
  /** CL_DOCUSIGN_ENABLED is exactly "1". */
  enabled: boolean;
  /** Names of the DOCUSIGN_* variables that are missing (never their values). */
  missing: string[];
  /** enabled and nothing missing. */
  ok: boolean;
}

export interface AgreementStatus {
  /** The owner's setting; null = it couldn't be read. */
  setting: AgreementMode | null;
  capability: DocusignCapability;
  /** What /book and checkout use right now. */
  effective: AgreementMode;
}

export function isAgreementMode(v: unknown): v is AgreementMode {
  return v === "attest" || v === "docusign";
}

export function resolveEffectiveMode(setting: AgreementMode | null, capability: Pick<DocusignCapability, "ok">): AgreementMode {
  return setting === "docusign" && capability.ok === true ? "docusign" : "attest";
}

export type BannerTone = "neutral" | "on" | "warn";

/** The staff banner: what /book uses, and why when the two keys disagree. */
export function agreementBanner(s: AgreementStatus): { tone: BannerTone; text: string } {
  if (s.effective === "docusign") {
    return { tone: "on", text: "Online rental agreement: DocuSign. Customers sign in DocuSign before they can pay." };
  }
  if (s.setting === null) {
    return {
      tone: "warn",
      text: "Online rental agreement: PowerForm and checkbox. The agreement setting couldn't be read, so /book uses the PowerForm.",
    };
  }
  if (s.setting === "docusign") {
    return {
      tone: "warn",
      text: `Online rental agreement: PowerForm and checkbox. Settings say DocuSign, but this deployment isn't set up for it (${capabilityGap(s.capability)}), so /book uses the PowerForm.`,
    };
  }
  return { tone: "neutral", text: "Online rental agreement: PowerForm and checkbox." };
}

/** Why the capability is missing, in names only. */
export function capabilityGap(c: DocusignCapability): string {
  const parts: string[] = [];
  if (!c.enabled) parts.push("CL_DOCUSIGN_ENABLED is not 1");
  if (c.missing.length) parts.push(`missing ${c.missing.join(", ")}`);
  return parts.length ? parts.join("; ") : "ready";
}

/** Server refusal when the customer's page and the current mode disagree. */
export const MODE_CHANGED = {
  code: "agreement_mode_changed",
  error: "How the rental agreement is signed online just changed. Please reload this page and complete the agreement again. You were not charged.",
} as const;
