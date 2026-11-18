import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { missingDocusignEnv } from "./config";
import {
  isAgreementMode,
  resolveEffectiveMode,
  type AgreementMode,
  type AgreementStatus,
  type DocusignCapability,
} from "./mode-shared";

export * from "./mode-shared";

/**
 * The rental-agreement switch, server part. See mode-shared.ts for the rule.
 * /book is anonymous and checkout runs as service_role, so the setting is read
 * through booking_agreement_mode() (service_role only, migration
 * 20261117000000). Any read failure, including the function not existing yet
 * (migration not applied), is treated as attest.
 */

export function docusignCapability(): DocusignCapability {
  const enabled = process.env.CL_DOCUSIGN_ENABLED?.trim() === "1";
  const missing = missingDocusignEnv();
  return { enabled, missing, ok: enabled && missing.length === 0 };
}

/** The owner's setting, or null when it can't be read. */
export async function readAgreementSetting(): Promise<AgreementMode | null> {
  try {
    const { data, error } = await createServiceClient().rpc("booking_agreement_mode");
    if (error) return null;
    return isAgreementMode(data) ? data : null;
  } catch {
    return null;
  }
}

export async function getAgreementStatus(): Promise<AgreementStatus> {
  const capability = docusignCapability();
  const setting = await readAgreementSetting();
  return { setting, capability, effective: resolveEffectiveMode(setting, capability) };
}

/** What /book and checkout use right now: docusign only when both keys say so. */
export async function effectiveAgreementMode(): Promise<AgreementMode> {
  const capability = docusignCapability();
  // Without the capability the setting can't matter: don't even read it.
  if (!capability.ok) return "attest";
  return resolveEffectiveMode(await readAgreementSetting(), capability);
}
