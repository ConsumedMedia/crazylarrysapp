/**
 * Unit test — source scan, no rendering. Every toLocaleString /
 * toLocaleDateString / toLocaleTimeString / Intl.DateTimeFormat call in app/
 * and lib/ must name a timeZone. Timestamps should use lib/time/yard.ts
 * (America/New_York). Date-only yyyy-mm-dd values are parsed as UTC midnight
 * and formatted with timeZone "UTC". With no zone, Vercel's UTC clock decides
 * what people see.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const CALL = /\.toLocale(?:Date|Time)?String\(|Intl\.DateTimeFormat\(/g;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** The argument text of the call that opens at `open` (index of "("). */
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

describe("date formatting always names a time zone", () => {
  it("has no zone-less toLocale*/Intl.DateTimeFormat calls in app/ or lib/", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const file of [...sourceFiles(path.join(ROOT, "app")), ...sourceFiles(path.join(ROOT, "lib"))]) {
      const src = fs.readFileSync(file, "utf8");
      for (const m of Array.from(src.matchAll(CALL))) {
        checked++;
        const args = callArgs(src, (m.index ?? 0) + m[0].length - 1);
        // lib/time/yard.ts passes its zone by spreading options + timeZone.
        if (!/timeZone/.test(args)) {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(`${path.relative(ROOT, file)}:${line}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(20); // the scan really found the formatters
    expect(offenders).toEqual([]);
  });
});
