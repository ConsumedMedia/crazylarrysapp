import "server-only";
import { getPool } from "./tokens";
import { quickbooksJson } from "./client";

/**
 * Fetch the connected company's display name from the Accounting API and store
 * it on quickbooks_connection.company_name. Called once by the OAuth callback
 * after a successful connect; failure here is non-fatal (the connection is
 * still valid, the name just shows as blank).
 */
interface CompanyInfoResponse {
  CompanyInfo?: {
    CompanyName?: string;
    LegalName?: string;
  };
}

export async function syncCompanyName(realmId: string): Promise<string | null> {
  let name: string | null = null;
  try {
    const data = await quickbooksJson<CompanyInfoResponse>(
      `companyinfo/${realmId}`,
    );
    name =
      data.CompanyInfo?.CompanyName ?? data.CompanyInfo?.LegalName ?? null;
  } catch {
    return null;
  }
  if (!name) return null;

  await getPool().query(
    `update public.quickbooks_connection
        set company_name = $1, updated_at = now()
      where id = true`,
    [name],
  );
  return name;
}
