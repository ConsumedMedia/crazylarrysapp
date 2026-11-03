/**
 * /pay/<token> must never read a session: a staff member's browser may be
 * signed in, and the token is the page's only credential. Static checks:
 *
 *  1. Everything the /pay route imports, followed through the repo's own
 *     modules, uses no session API (server cookie client, @supabase/ssr,
 *     cookies(), auth.getUser, the staff/customer guards).
 *  2. The middleware (which refreshes sessions) doesn't run on /pay/*, and
 *     still runs on the pages it ran on before.
 *  3. next.config sends /pay/* with the card-page CSP, no-referrer, no-store
 *     and noindex.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const ENTRY = ["page.tsx", "actions.ts", "PayLinkForm.tsx"].map((f) => path.join(ROOT, "app/(customer)/pay/[token]", f));
const FORBIDDEN: Array<[RegExp, string]> = [
  [/["']@\/lib\/supabase\/server["']/, "the cookie-session Supabase client"],
  [/["']@supabase\/ssr["']/, "@supabase/ssr"],
  [/\bcookies\s*\(/, "cookies()"],
  [/\.auth\.getUser\s*\(/, "auth.getUser()"],
  [/\b(requireStaff|assertStaff|requireCustomer|requireDriver)\b/, "a session guard"],
];

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null; // a package
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

function importGraph(entries: string[]): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    seen.set(file, src);
    for (const m of Array.from(src.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g))) {
      const next = resolveImport(file, m[1] ?? m[2]);
      if (next && !next.includes(`${path.sep}node_modules${path.sep}`)) queue.push(next);
    }
  }
  return seen;
}

describe("/pay never reads a session", () => {
  const graph = importGraph(ENTRY);

  it("walks the real import graph (page, action, form and what they pull in)", () => {
    const rel = Array.from(graph.keys()).map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
    expect(rel).toEqual(expect.arrayContaining([
      "lib/pay-links/pay.ts",
      "lib/pay-links/token.ts",
      "lib/payments/CardFields.tsx",
      "lib/notifications/notify.ts",
      "lib/quickbooks/payments.ts",
      "app/(customer)/book/_components/AgreementModal.tsx",
    ]));
  });

  it("no module it imports uses a session API", () => {
    const hits: string[] = [];
    for (const [file, src] of Array.from(graph)) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const [re, what] of FORBIDDEN) if (re.test(code)) hits.push(`${path.relative(ROOT, file)}: ${what}`);
    }
    expect(hits).toEqual([]);
  });

  it("the session middleware skips /pay/*, and still covers the other pages", () => {
    const src = fs.readFileSync(path.join(ROOT, "middleware.ts"), "utf8");
    const matcher = src.match(/matcher:\s*\[[\s\S]*?"([^"]+)"/)![1].replace(/\\\\/g, "\\");
    const re = new RegExp(`^${matcher}$`);
    expect(re.test("/pay/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE")).toBe(false);
    for (const p of ["/book", "/bookings/new", "/dashboard", "/account", "/payments", "/pay"]) expect(re.test(p), p).toBe(true);
    expect(re.test("/api/webhooks/quo")).toBe(false);
  });

  it("/pay/* is served with the card CSP, no-referrer, no-store and noindex", async () => {
    const cfg = (await import("../../next.config.mjs")).default as { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> };
    const rules = await cfg.headers();
    const pay = rules.find((r) => r.source === "/pay/:path*");
    const h = Object.fromEntries((pay?.headers ?? []).map((x) => [x.key, x.value]));
    expect(h["Referrer-Policy"]).toBe("no-referrer");
    expect(h["Cache-Control"]).toMatch(/no-store/);
    expect(h["X-Robots-Tag"]).toMatch(/noindex/);
    const book = rules.find((r) => r.source === "/book")!.headers.find((x) => x.key === "Content-Security-Policy")!.value;
    expect(h["Content-Security-Policy"]).toBe(book);
  });
});
