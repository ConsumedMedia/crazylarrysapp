/**
 * Unit test — a refused checkout sends the customer to the wizard step that
 * owns the problem (1 Size, 2 Dates, 3 Details, null = stay on Review & pay).
 */
import { describe, it, expect } from "vitest";
import { refusalStep } from "./refusal-step";

// [code, reason (for "compensated"), step, clear the picked date]
const ROWS: Array<[string | undefined, string | undefined, 1 | 2 | 3 | null, boolean]> = [
  // refused before any charge
  ["bad_size", undefined, 1, false],
  ["bad_date", undefined, 2, true],
  ["past_date", undefined, 2, true],
  ["bad_address", undefined, 3, false],
  ["bad_contact", undefined, 3, false],
  ["no_contact", undefined, 3, false],
  ["bad_email", undefined, 3, false],
  ["bad_rental", undefined, null, false],
  ["agreement", undefined, null, false],
  ["no_token", undefined, null, false],
  ["pricing_not_configured", undefined, null, false],
  ["declined", undefined, null, false],
  [undefined, undefined, null, false],
  // charged, refused by the database, refunded
  ["compensated", "unavailable", 2, true],
  ["compensated", "past_date", 2, true],
  ["compensated", "blocked", 2, true],
  ["compensated", "unavailable_unrecognized", null, false],
  ["compensated", "pricing_not_configured", null, false],
  ["compensated", "P0001", null, false],
  ["compensated", "error", null, false],
  ["compensated", "bad_address", null, false],
  ["compensated", undefined, null, false],
];

describe("refusalStep", () => {
  it.each(ROWS)("%s / %s -> step %s, clear date %s", (code, reason, step, clearDate) => {
    expect(refusalStep(code, reason)).toEqual({ step, clearDate });
  });
});
