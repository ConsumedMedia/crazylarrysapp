/**
 * Unit test — source scan, no rendering. The yard's "today" comes from
 * lib/time/yard.ts (yardToday / yardTomorrow / yardDateOf). Taking the
 * calendar day straight off the clock in UTC is refused anywhere else in app/
 * and lib/, because from 8 PM EDT / 7 PM EST it is already tomorrow:
 *
 *   new Date().toISOString().slice(0, 10)          (same line)
 *   Date.now() ... .toISOString().slice(0, 10)      (same line)
 *   const n = new Date(); ... n.getUTCDate() / n.setUTCDate(...) / n.toISOString().slice(0, 10)
 *                                                    (within the next 4 lines)
 *
 * Calendar arithmetic on a yyyy-mm-dd (new Date(Date.UTC(y, m, d)) and the
 * like) is fine and isn't matched.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const SKIP = new Set([path.join("lib", "time", "yard.ts")]);

const SAME_LINE = [/new Date\(\)\s*\.toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/, /Date\.now\(\)[^\n]*\.toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/];
const NOW_VAR = /(?:const|let|var)\s+(\w+)\s*=\s*new Date\(\)\s*;/;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

function utcTodayOffenders(src: string): number[] {
  const lines = src.split("\n");
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (SAME_LINE.some((re) => re.test(line))) hits.push(i + 1);
    const m = NOW_VAR.exec(line);
    if (m) {
      const v = m[1];
      const use = new RegExp(`\\b${v}\\.(?:getUTC(?:FullYear|Month|Date|Day)|setUTCDate)\\(|\\b${v}\\.toISOString\\(\\)\\s*\\.slice\\(\\s*0`);
      if (lines.slice(i + 1, i + 5).some((l) => use.test(l))) hits.push(i + 1);
    }
  });
  return hits;
}

describe("the yard's today never comes straight off a UTC clock", () => {
  it("recognises each pattern it is meant to refuse (self-check)", () => {
    expect(utcTodayOffenders("const d = new Date().toISOString().slice(0, 10);")).toEqual([1]);
    expect(utcTodayOffenders("const t = new Date(Date.now() + 864e5).toISOString().slice(0, 10);")).toEqual([1]);
    expect(utcTodayOffenders("const n = new Date();\nreturn new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));")).toEqual([1]);
    expect(utcTodayOffenders("const since = new Date();\nsince.setUTCDate(since.getUTCDate() - 7);")).toEqual([1]);
    // Calendar arithmetic on a yyyy-mm-dd is allowed.
    expect(utcTodayOffenders("return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);")).toEqual([]);
  });

  it("finds none in app/ or lib/ outside lib/time/yard.ts", () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(path.join(ROOT, "app")), ...sourceFiles(path.join(ROOT, "lib"))]) {
      const rel = path.relative(ROOT, file);
      if (SKIP.has(rel)) continue;
      for (const line of utcTodayOffenders(fs.readFileSync(file, "utf8"))) offenders.push(`${rel}:${line}`);
    }
    expect(offenders).toEqual([]);
  });
});
