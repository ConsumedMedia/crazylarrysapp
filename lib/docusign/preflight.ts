import "server-only";
import { getDocusignConfig } from "./config";
import { getDocusignAccessToken } from "./auth";
import { docusignJson } from "./client";
import { AGREEMENT_ROLE } from "./envelopes";
import { docusignCapability } from "./mode";

/**
 * Staff-only "Check DocuSign" (Settings): can THIS deployment create the
 * rental-agreement envelope? Read-only against DocuSign: one token request
 * (JWT grant) and two GETs (the template and its recipients). Creates no
 * envelope, sends nothing, changes nothing, and is independent of the mode.
 *
 * Reports names, ids that are not secret (template name, role names,
 * environment, hosts) and DocuSign's error codes. Never a token, key or
 * credential value.
 */

export interface PreflightStep {
  key: "switch" | "credentials" | "key" | "token" | "template" | "role";
  label: string;
  ok: boolean;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  /** sandbox | production, once the config could be read. */
  environment: string | null;
  steps: PreflightStep[];
  checkedAt: string;
}

function errText(e: unknown): string {
  const code = (e as { code?: unknown; errorCode?: unknown })?.errorCode ?? (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return (typeof code === "string" && code && !msg.includes(code) ? `${code}: ` : "") + msg.slice(0, 240);
}

export async function runDocusignPreflight(now: () => Date = () => new Date()): Promise<PreflightResult> {
  const steps: PreflightStep[] = [];
  const cap = docusignCapability();
  let environment: string | null = null;
  const done = (): PreflightResult => ({ ok: steps.every((s) => s.ok), environment, steps, checkedAt: now().toISOString() });

  steps.push({
    key: "switch",
    label: "Switched on for this deployment",
    ok: cap.enabled,
    detail: cap.enabled ? "CL_DOCUSIGN_ENABLED is 1." : "CL_DOCUSIGN_ENABLED is not 1, so /book stays on the PowerForm here whatever Settings say.",
  });
  steps.push({
    key: "credentials",
    label: "Credentials present",
    ok: cap.missing.length === 0,
    detail: cap.missing.length === 0 ? "Every DOCUSIGN_* variable is set." : `Missing: ${cap.missing.join(", ")}.`,
  });
  if (cap.missing.length) return done();

  let templateId: string;
  try {
    const cfg = getDocusignConfig();
    environment = cfg.environment;
    templateId = cfg.templateId;
    steps.push({
      key: "key",
      label: "Configuration readable",
      ok: true,
      detail: `${cfg.environment} · sign-in at ${cfg.authHost} · API at ${new URL(cfg.apiBase).host}.`,
    });
  } catch (e) {
    steps.push({ key: "key", label: "Configuration readable", ok: false, detail: errText(e) });
    return done();
  }

  try {
    await getDocusignAccessToken();
    steps.push({ key: "token", label: "Signs in (JWT grant)", ok: true, detail: "DocuSign issued an access token." });
  } catch (e) {
    const consent = /consent_required/.test(String((e as Error)?.message));
    steps.push({
      key: "token",
      label: "Signs in (JWT grant)",
      ok: false,
      detail: errText(e) + (consent ? " The impersonated user has to grant consent to the integration key first." : ""),
    });
    return done();
  }

  try {
    const t = await docusignJson<{ templateId?: string; name?: string }>(`templates/${encodeURIComponent(templateId)}`);
    steps.push({ key: "template", label: "Agreement template found", ok: true, detail: `“${t.name ?? "(no name)"}”.` });
  } catch (e) {
    steps.push({ key: "template", label: "Agreement template found", ok: false, detail: errText(e) });
    return done();
  }

  try {
    const r = await docusignJson<{ signers?: Array<{ roleName?: string }> }>(`templates/${encodeURIComponent(templateId)}/recipients`);
    const roles = (r.signers ?? []).map((s) => s.roleName ?? "").filter(Boolean);
    const has = roles.includes(AGREEMENT_ROLE);
    steps.push({
      key: "role",
      label: `Signer role “${AGREEMENT_ROLE}”`,
      ok: has,
      detail: has
        ? `Present (signer roles: ${roles.join(", ")}).`
        : `Not found. The template's signer roles are: ${roles.length ? roles.join(", ") : "none"}. Rename the signer role to exactly “${AGREEMENT_ROLE}”.`,
    });
  } catch (e) {
    steps.push({ key: "role", label: `Signer role “${AGREEMENT_ROLE}”`, ok: false, detail: errText(e) });
  }
  return done();
}
