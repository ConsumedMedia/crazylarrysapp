import "server-only";

/**
 * DocuSign eSignature config — env-driven so sandbox -> production is a config
 * change (plus DocuSign Go-Live promotion + production consent), not a code
 * change. Server-only: none of these may ever be NEXT_PUBLIC_.
 *
 *   DOCUSIGN_ENVIRONMENT       sandbox | production
 *   DOCUSIGN_AUTH_SERVER       account-d.docusign.com (sandbox) / account.docusign.com
 *   DOCUSIGN_BASE_PATH         https://demo.docusign.net/restapi (the account's base_uri + /restapi)
 *   DOCUSIGN_INTEGRATION_KEY   app's integration key (JWT iss)
 *   DOCUSIGN_USER_ID           user GUID the app impersonates (JWT sub)
 *   DOCUSIGN_ACCOUNT_ID        API account id
 *   DOCUSIGN_TEMPLATE_ID       the rental-agreement template every checkout
 *                              envelope is created from. Read directly — the
 *                              old public PowerForm is not used and can stay
 *                              deactivated.
 *   DOCUSIGN_PRIVATE_KEY_B64   base64 of the RSA key PEM (may also contain the
 *                              public key block; only the private block is used)
 */

const REQUIRED = [
  "DOCUSIGN_AUTH_SERVER",
  "DOCUSIGN_BASE_PATH",
  "DOCUSIGN_INTEGRATION_KEY",
  "DOCUSIGN_USER_ID",
  "DOCUSIGN_ACCOUNT_ID",
  "DOCUSIGN_TEMPLATE_ID",
  "DOCUSIGN_PRIVATE_KEY_B64",
] as const;

export interface DocusignConfig {
  environment: "sandbox" | "production";
  authHost: string; // no scheme
  apiBase: string; // https://.../restapi/v2.1/accounts/<id>
  integrationKey: string;
  userId: string;
  accountId: string;
  templateId: string;
  privateKeyPem: string;
}

export function missingDocusignEnv(): string[] {
  return REQUIRED.filter((k) => !process.env[k]?.trim());
}

export function docusignConfigured(): boolean {
  return missingDocusignEnv().length === 0;
}

let cached: DocusignConfig | null = null;

export function getDocusignConfig(): DocusignConfig {
  if (cached) return cached;
  const missing = missingDocusignEnv();
  if (missing.length) {
    throw new Error(`DocuSign not configured: missing ${missing.join(", ")}`);
  }
  const env = process.env;
  const decoded = Buffer.from(env.DOCUSIGN_PRIVATE_KEY_B64!.trim(), "base64").toString("utf8");
  const privateKeyPem = decoded.match(
    /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/,
  )?.[0];
  if (!privateKeyPem) {
    throw new Error("DOCUSIGN_PRIVATE_KEY_B64 does not contain a PRIVATE KEY block");
  }
  const environment = env.DOCUSIGN_ENVIRONMENT === "production" ? "production" : "sandbox";
  cached = {
    environment,
    authHost: env.DOCUSIGN_AUTH_SERVER!.trim().replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    apiBase: `${env.DOCUSIGN_BASE_PATH!.trim().replace(/\/+$/, "")}/v2.1/accounts/${env.DOCUSIGN_ACCOUNT_ID!.trim()}`,
    integrationKey: env.DOCUSIGN_INTEGRATION_KEY!.trim(),
    userId: env.DOCUSIGN_USER_ID!.trim(),
    accountId: env.DOCUSIGN_ACCOUNT_ID!.trim(),
    templateId: env.DOCUSIGN_TEMPLATE_ID!.trim(),
    privateKeyPem,
  };
  return cached;
}
