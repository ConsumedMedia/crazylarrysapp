/**
 * Static guard over the app's source (no database): staff lost table-wide
 * SELECT on pay_links (20261103010000), so every read must name its columns,
 * and nothing in the UI may name token_hash or token_encrypted.
 *
 *  - Every `.from("pay_links")` is followed by `.select(<literal or
 *    PAY_LINK_STAFF_COLUMNS>)` with no `*` and no token column.
 *  - Outside comments, `token_hash` / `token_encrypted` appear in no file
 *    under app/ or lib/ (tests and the service-role pay/cron paths that use
 *    RPCs don't need them either).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PAY_LINK_STAFF_COLUMNS } from "./booking-state";

const ROOT = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__snapshots__" || name.startsWith(".")) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib"))].map((p) => ({
  path: relative(ROOT, p).replace(/\\/g, "/"),
  text: readFileSync(p, "utf8"),
}));

/** Source with // and /* *\/ comments blanked (good enough for this codebase). */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("pay_links reads in app/ and lib/", () => {
  const reads = files.flatMap((f) =>
    Array.from(f.text.matchAll(/\.from\(\s*["']pay_links["']\s*\)\s*\.select\(([^)]*)\)/g)).map((m) => ({ file: f.path, arg: m[1].trim() })),
  );
  const fromCalls = files.flatMap((f) => Array.from(f.text.matchAll(/\.from\(\s*["']pay_links["']\s*\)/g)).map(() => f.path));

  it("every .from(\"pay_links\") is a select we can see (no insert/update/delete from the app)", () => {
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.length).toBe(fromCalls.length);
  });

  it("each select names its columns: no *, no empty select, no token column", () => {
    for (const r of reads) {
      const cols =
        r.arg === "PAY_LINK_STAFF_COLUMNS" ? PAY_LINK_STAFF_COLUMNS : /^["'`]([^"'`]*)["'`]$/.test(r.arg) ? r.arg.slice(1, -1) : null;
      expect(cols, `${r.file}: select(${r.arg}) must be a string literal or PAY_LINK_STAFF_COLUMNS`).not.toBeNull();
      expect(cols!.trim(), `${r.file}`).not.toBe("");
      expect(cols, `${r.file}`).not.toMatch(/\*|\btoken_hash\b|\btoken_encrypted\b/);
    }
  });

  it("no code under app/ or lib/ names token_hash or token_encrypted", () => {
    // Word-bounded: QuickBooks' refresh_token_encrypted is a different column.
    const hits = files.filter((f) => /\btoken_hash\b|\btoken_encrypted\b/.test(code(f.text))).map((f) => f.path);
    expect(hits).toEqual([]);
  });
});
