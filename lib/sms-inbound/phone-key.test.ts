import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { smsPhoneKey } from "./phone-key";

// The cases come from scripts/probe-sms-opt-outs.mjs (KEY_CASES), which checks
// public._sms_phone_key against the same table, so the SQL and TypeScript rules
// can't drift apart unnoticed.
const PROBE = fileURLToPath(new URL("../../scripts/probe-sms-opt-outs.mjs", import.meta.url));
function probeCases(): Array<[string | null, string | null]> {
  const src = readFileSync(PROBE, "utf8");
  const m = src.match(/const KEY_CASES = (\[[\s\S]*?\n\]);/);
  if (!m) throw new Error("KEY_CASES not found in the probe");
  return JSON.parse(m[1].replace(/,\s*\]$/, "]"));
}
const KEY_CASES = probeCases();

describe("smsPhoneKey (mirrors public._sms_phone_key)", () => {
  it("reads the probe's table", () => {
    expect(KEY_CASES.length).toBeGreaterThanOrEqual(14);
  });

  it.each(KEY_CASES)("%j -> %j", (raw, want) => {
    expect(smsPhoneKey(raw)).toBe(want);
  });

  it("covers every stored phone shape seen live (masked): 999-999-9999, 9999999999, +9 (999) 999-9999, (999) 999-9999", () => {
    for (const shape of ["614-555-0143", "6145550143", "+1 (614) 555-0143", "(614) 555-0143"]) {
      expect(smsPhoneKey(shape)).toBe("6145550143");
    }
  });
});
