// Load .env.local into process.env for tests, the same way Next does.
import { loadEnvConfig } from "@next/env";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

loadEnvConfig(process.cwd());

// Fallback: @next/env's loader can no-op under the vitest worker depending on
// cwd/caching. Parse .env.local directly for anything still missing.
try {
  const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  /* no .env.local — CI may inject env directly */
}
