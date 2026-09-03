import { getQuickBooksStatus } from "@/lib/quickbooks/status";

function fmt(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const NOTICES: Record<string, { tone: "ok" | "warn"; text: string }> = {
  connected: { tone: "ok", text: "QuickBooks connected." },
  disconnected: { tone: "warn", text: "QuickBooks disconnected." },
  error: {
    tone: "warn",
    text: "QuickBooks connection failed. Check the details below and try again.",
  },
  state_mismatch: {
    tone: "warn",
    text: "The connection request expired or didn't match. Start again.",
  },
  not_configured: {
    tone: "warn",
    text: "QuickBooks environment variables are not set on the server.",
  },
};

export async function QuickBooksPanel({
  notice,
}: {
  notice?: string;
}) {
  const s = await getQuickBooksStatus();
  const n = notice ? NOTICES[notice] : undefined;

  const connected = s.status === "connected";
  const badge = connected
    ? { label: "Connected", cls: "bg-teal text-white" }
    : s.status === "error"
      ? { label: "Error", cls: "bg-orange text-white" }
      : { label: "Not connected", cls: "border-2 border-line-strong text-ink-2" };

  return (
    <section className="border-2 border-line-strong bg-surface">
      <div className="flex items-center justify-between border-b-2 border-line-strong px-4 py-3">
        <span className="text-[15px] font-extrabold">QuickBooks Payments</span>
        <span
          className={`px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.12em] ${badge.cls}`}
        >
          {badge.label}
        </span>
      </div>

      <div className="flex flex-col gap-4 p-4">
        {n && (
          <p
            className={
              n.tone === "ok"
                ? "border-l-4 border-teal bg-teal-tint px-3 py-2 text-[13px] font-semibold text-teal-tint-ink"
                : "border-l-4 border-orange bg-orange-tint px-3 py-2 text-[13px] font-semibold text-orange-tint-ink"
            }
          >
            {n.text}
          </p>
        )}

        {!s.configured && (
          <p className="text-[12px] text-ink-2">
            Set <code>QUICKBOOKS_CLIENT_ID</code>,{" "}
            <code>QUICKBOOKS_CLIENT_SECRET</code>,{" "}
            <code>QUICKBOOKS_REDIRECT_URI</code>,{" "}
            <code>QUICKBOOKS_ENVIRONMENT</code>,{" "}
            <code>QUICKBOOKS_TOKEN_ENC_KEY</code>, and <code>DATABASE_URL</code>{" "}
            in <code>.env.local</code>, then restart the server.
          </p>
        )}

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          <dt className="font-bold text-ink-3">Company</dt>
          <dd className="cl-nums">{s.companyName ?? "—"}</dd>
          <dt className="font-bold text-ink-3">Realm ID</dt>
          <dd className="cl-nums">{s.realmId ?? "—"}</dd>
          <dt className="font-bold text-ink-3">Connected</dt>
          <dd className="cl-nums">{fmt(s.connectedAt)}</dd>
          <dt className="font-bold text-ink-3">Last token refresh</dt>
          <dd className="cl-nums">
            {fmt(s.lastRefreshAt)}
            {s.refreshCount > 0 ? ` (${s.refreshCount}×)` : ""}
          </dd>
          <dt className="font-bold text-ink-3">Access token expires</dt>
          <dd className="cl-nums">{fmt(s.accessTokenExpiresAt)}</dd>
        </dl>

        {s.lastError && (
          <p className="border-2 border-orange bg-orange-tint px-3 py-2 text-[12px] font-semibold text-orange-tint-ink">
            Last error: {s.lastError}
          </p>
        )}

        <div className="flex items-center gap-3">
          <a
            href="/api/quickbooks/connect"
            className="bg-teal px-3.5 py-2 text-[12px] font-extrabold text-white hover:bg-teal-700"
          >
            {connected ? "Reconnect" : "Connect QuickBooks"}
          </a>
          {connected && (
            <form action="/api/quickbooks/disconnect" method="post">
              <button
                type="submit"
                className="border-2 border-line-strong px-3.5 py-2 text-[12px] font-extrabold text-ink-2 hover:bg-bg"
              >
                Disconnect
              </button>
            </form>
          )}
        </div>
        <p className="text-[11px] text-ink-3">
          Connecting or reconnecting QuickBooks is owner-only. Tokens are stored
          encrypted on the server and never reach the browser.
        </p>
      </div>
    </section>
  );
}
