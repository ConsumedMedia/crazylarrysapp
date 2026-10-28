/** Unit test — pure string handling. */
import { describe, it, expect } from "vitest";
import { redactCardNumbers, REDACTED_CARD } from "./redact";

describe("redactCardNumbers", () => {
  it.each([
    ["4111111111111111", "16 digits, no separators"],
    ["4111 1111 1111 1111", "grouped by spaces"],
    ["4111-1111-1111-1111", "grouped by dashes"],
    ["378282246310005", "15-digit Amex"],
    ["3782 822463 10005", "Amex grouping"],
    ["6011000990139424", "Discover"],
    ["4222222222222", "13 digits"],
    ["4111111111111111111", "19 digits"],
  ])("removes %s (%s)", (card) => {
    const out = redactCardNumbers(`my card is ${card} exp 12/29`);
    expect(out).toBe(`my card is ${REDACTED_CARD} exp 12/29`);
    expect(out).not.toMatch(/\d{5,}/);
  });

  it("removes every run in a line", () => {
    expect(redactCardNumbers("4111111111111111 or 5555 5555 5555 4444")).toBe(
      `${REDACTED_CARD} or ${REDACTED_CARD}`,
    );
  });

  it.each([
    ["(614) 555-0142", "a phone number"],
    ["+16145550142", "an E.164 phone number"],
    ["1-614-555-0142", "a dialled phone number"],
    ["2026-10-28", "a date"],
    ["43004", "a ZIP"],
    ["$401.05", "an amount"],
    ["unit 20-31", "a fleet unit id"],
    ["123456789012", "12 digits (too short for a card)"],
    ["12345678901234567890", "20 digits (too long for a card)"],
  ])("leaves %s alone (%s)", (text) => {
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("documents the known gap: a number split across turns is not caught", () => {
    expect(redactCardNumbers("4111 1111")).toBe("4111 1111");
  });
});
