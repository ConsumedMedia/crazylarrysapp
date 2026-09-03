import "server-only";
import { Pool, type PoolClient } from "pg";
import {
  QB_TOKEN_URL,
  QB_REVOKE_URL,
  basicAuthHeader,
  getQuickBooksConfig,
} from "./config";

/**
 * QuickBooks token manager.
 *
 * Owns the single row of public.quickbooks_connection. Uses a direct Postgres
 * connection (not supabase-js) because refreshing a token safely requires
 * holding a transaction open — SELECT ... FOR UPDATE on the row — across the
 * network round-trip to Intuit, so two concurrent requests can't both refresh
 * and race the refresh-token rotation.
 *
 * The refresh token is stored encrypted (pgp_sym_encrypt, key from
 * QUICKBOOKS_TOKEN_ENC_KEY). The access token is stored plaintext but is
 * short-lived (~1h) and the table has RLS enabled with zero policies, so it is
 * unreadable via PostgREST. Nothing here is ever sent to the browser or logged.
 */

// --- connection pool ---------------------------------------------------------

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const { databaseUrl } = getQuickBooksConfig();
  pool = new Pool({
    connectionString: databaseUrl,
    max: 3,
    idleTimeoutMillis: 30_000,
    // Supabase requires TLS; its pooler cert chain isn't in the default store.
    ssl: { rejectUnauthorized: false },
  });
  return pool;
}

// --- error scrubbing --------------------------------------------------------

/** Short, safe string for the DB last_error column and server logs. */
function scrub(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  if (typeof err === "string") return err.slice(0, 500);
  return "unknown error";
}

// --- Intuit token endpoint --------------------------------------------------

interface IntuitTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds, ~3600
  x_refresh_token_expires_in: number; // seconds, ~8726400 (101 days)
  token_type: string;
}

async function callIntuitToken(
  body: Record<string, string>,
): Promise<IntuitTokenResponse> {
  const res = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    // Intuit returns { error, error_description } — safe to surface, no secrets.
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: string; error_description?: string };
      detail = [j.error, j.error_description].filter(Boolean).join(": ") || detail;
    } catch {
      /* keep raw slice */
    }
    throw new Error(`Intuit token endpoint ${res.status}: ${detail}`);
  }
  return JSON.parse(text) as IntuitTokenResponse;
}

// --- row helpers ----------------------------------------------------------

interface ConnectionRow {
  realm_id: string | null;
  access_token: string | null;
  access_token_expires_at: Date | null;
  refresh_token: string | null; // decrypted in the SELECT
  refresh_token_expires_at: Date | null;
  status: string;
}

async function lockRow(client: PoolClient): Promise<ConnectionRow> {
  const { tokenEncKey } = getQuickBooksConfig();
  const { rows } = await client.query(
    `select realm_id,
            access_token,
            access_token_expires_at,
            case when refresh_token_encrypted is null then null
                 else pgp_sym_decrypt(refresh_token_encrypted, $1) end as refresh_token,
            refresh_token_expires_at,
            status
       from public.quickbooks_connection
      where id = true
      for update`,
    [tokenEncKey],
  );
  if (!rows.length) {
    throw new Error("quickbooks_connection row missing");
  }
  return rows[0] as ConnectionRow;
}

async function writeTokens(
  client: PoolClient,
  opts: {
    realmId: string;
    accessToken: string;
    accessExpiresInSec: number;
    refreshToken: string;
    refreshExpiresInSec: number;
    connectedBy?: string | null;
    markConnectedAt?: boolean;
    bumpRefreshCount: boolean;
  },
): Promise<void> {
  const { tokenEncKey } = getQuickBooksConfig();
  await client.query(
    `update public.quickbooks_connection set
        realm_id                 = $1,
        access_token             = $2,
        access_token_expires_at  = now() + make_interval(secs => $3),
        refresh_token_encrypted  = pgp_sym_encrypt($4, $5),
        refresh_token_expires_at = now() + make_interval(secs => $6),
        status                   = 'connected',
        last_error               = null,
        refresh_count            = refresh_count + case when $7 then 1 else 0 end,
        last_refresh_at          = case when $7 then now() else last_refresh_at end,
        connected_by             = coalesce($8, connected_by),
        connected_at             = case when $9 then now() else connected_at end
      where id = true`,
    [
      opts.realmId,
      opts.accessToken,
      opts.accessExpiresInSec,
      opts.refreshToken,
      tokenEncKey,
      opts.refreshExpiresInSec,
      opts.bumpRefreshCount,
      opts.connectedBy ?? null,
      opts.markConnectedAt ?? false,
    ],
  );
}

async function writeError(client: PoolClient, message: string): Promise<void> {
  await client.query(
    `update public.quickbooks_connection
        set status = 'error', last_error = $1, updated_at = now()
      where id = true`,
    [message],
  );
}

// --- public API -----------------------------------------------------------

/**
 * OAuth step 2: exchange the authorization code for the first token pair and
 * persist the connection. Called only from the owner-gated callback route.
 */
export async function connectWithAuthCode(opts: {
  code: string;
  realmId: string;
  connectedBy: string;
}): Promise<void> {
  const { redirectUri } = getQuickBooksConfig();
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await lockRow(client); // serialize against any in-flight refresh
    const tok = await callIntuitToken({
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: redirectUri,
    });
    await writeTokens(client, {
      realmId: opts.realmId,
      accessToken: tok.access_token,
      accessExpiresInSec: tok.expires_in,
      refreshToken: tok.refresh_token,
      refreshExpiresInSec: tok.x_refresh_token_expires_in,
      connectedBy: opts.connectedBy,
      markConnectedAt: true,
      bumpRefreshCount: false,
    });
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    // Best-effort: record the failure on its own tiny transaction.
    try {
      await client.query("begin");
      await writeError(client, scrub(err));
      await client.query("commit");
    } catch {
      await client.query("rollback").catch(() => {});
    }
    throw err;
  } finally {
    client.release();
  }
}

const REFRESH_BUFFER_SEC = 5 * 60; // refresh if the token expires within 5 min

/**
 * Return a valid access token + realm id, refreshing first if the stored token
 * is within REFRESH_BUFFER_SEC of expiry (or already expired).
 *
 * This is the single choke point every QuickBooks API call goes through. The
 * FOR UPDATE lock means a second concurrent caller blocks until the first
 * commits, then re-reads and sees the fresh token — never a double refresh,
 * never a reuse of an already-rotated refresh token.
 *
 * @param minRemainingSec override the buffer (the daily cron passes a large
 *   value to force a proactive refresh and keep the refresh token rolling).
 */
export async function getValidAccessToken(
  minRemainingSec = REFRESH_BUFFER_SEC,
): Promise<{ accessToken: string; realmId: string; refreshed: boolean }> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const row = await lockRow(client);

    if (!row.refresh_token || !row.realm_id || row.status === "disconnected") {
      await client.query("rollback");
      throw new Error("QuickBooks is not connected");
    }

    const expMs = row.access_token_expires_at?.getTime() ?? 0;
    const stillGood =
      row.access_token && expMs - Date.now() > minRemainingSec * 1000;

    if (stillGood) {
      await client.query("commit");
      return {
        accessToken: row.access_token as string,
        realmId: row.realm_id,
        refreshed: false,
      };
    }

    // Refresh.
    try {
      const tok = await callIntuitToken({
        grant_type: "refresh_token",
        refresh_token: row.refresh_token,
      });
      await writeTokens(client, {
        realmId: row.realm_id,
        accessToken: tok.access_token,
        accessExpiresInSec: tok.expires_in,
        refreshToken: tok.refresh_token, // Intuit rotates this every time
        refreshExpiresInSec: tok.x_refresh_token_expires_in,
        bumpRefreshCount: true,
      });
      await client.query("commit");
      return {
        accessToken: tok.access_token,
        realmId: row.realm_id,
        refreshed: true,
      };
    } catch (err) {
      await writeError(client, scrub(err));
      await client.query("commit"); // persist the error state, then surface it
      throw err;
    }
  } finally {
    client.release();
  }
}

/**
 * Force the stored access token stale (dev/testing only — the calling route
 * must gate on CL_ENABLE_DEV_STUBS). Next getValidAccessToken() will refresh.
 */
export async function forceExpireAccessToken(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(
      `update public.quickbooks_connection
          set access_token_expires_at = now() - interval '1 minute',
              updated_at = now()
        where id = true`,
    );
  } finally {
    client.release();
  }
}

/**
 * Revoke the current refresh token at Intuit and clear the stored connection.
 * Owner-gated route only.
 */
export async function disconnect(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const row = await lockRow(client);
    const token = row.refresh_token ?? row.access_token;
    if (token) {
      try {
        await fetch(QB_REVOKE_URL, {
          method: "POST",
          headers: {
            Authorization: basicAuthHeader(),
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ token }),
          cache: "no-store",
        });
      } catch {
        /* revoke is best-effort; we still clear locally */
      }
    }
    await client.query(
      `update public.quickbooks_connection set
          access_token = null,
          access_token_expires_at = null,
          refresh_token_encrypted = null,
          refresh_token_expires_at = null,
          status = 'disconnected',
          last_error = null,
          updated_at = now()
        where id = true`,
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
