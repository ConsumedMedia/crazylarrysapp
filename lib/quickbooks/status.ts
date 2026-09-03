import "server-only";
import { createClient } from "@/lib/supabase/server";
import { quickBooksConfigured } from "./config";

export interface QuickBooksStatus {
  configured: boolean;
  status: "connected" | "disconnected" | "error" | "unknown";
  realmId: string | null;
  companyName: string | null;
  connectedAt: string | null;
  lastRefreshAt: string | null;
  refreshCount: number;
  lastError: string | null;
  accessTokenExpiresAt: string | null;
}

/**
 * Connection status for the /settings panel. Reads via the quickbooks_status()
 * RPC using the caller's own Supabase session (the RPC re-checks is_staff()).
 * Never returns tokens.
 */
export async function getQuickBooksStatus(): Promise<QuickBooksStatus> {
  const configured = quickBooksConfigured();
  const supabase = createClient();
  const { data, error } = await supabase.rpc("quickbooks_status");

  if (error || !data || !Array.isArray(data) || data.length === 0) {
    return {
      configured,
      status: "unknown",
      realmId: null,
      companyName: null,
      connectedAt: null,
      lastRefreshAt: null,
      refreshCount: 0,
      lastError: error?.message ?? null,
      accessTokenExpiresAt: null,
    };
  }

  const row = data[0] as Record<string, unknown>;
  return {
    configured,
    status: (row.status as QuickBooksStatus["status"]) ?? "unknown",
    realmId: (row.realm_id as string | null) ?? null,
    companyName: (row.company_name as string | null) ?? null,
    connectedAt: (row.connected_at as string | null) ?? null,
    lastRefreshAt: (row.last_refresh_at as string | null) ?? null,
    refreshCount: Number(row.refresh_count ?? 0),
    lastError: (row.last_error as string | null) ?? null,
    accessTokenExpiresAt: (row.access_token_expires_at as string | null) ?? null,
  };
}
