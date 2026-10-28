/**
 * Removes card-like digit runs from call text before it's stored.
 *
 * A "card-like run" is 13–19 digits, optionally grouped by single spaces or
 * dashes (4111 1111 1111 1111, 4111-1111-1111-1111, 378282246310005). Phone
 * numbers (10–11 digits), dates, ZIPs, amounts and unit ids are shorter and
 * pass through. No Luhn check: a false positive only hides a long number.
 *
 * Known limit: a number read out in pieces across several dialogue turns, or
 * spoken as words ("four one one one"), is not caught. Calls must not be used
 * to take card numbers — see the call-log plan's notes for Larry.
 */
export const REDACTED_CARD = "[card number removed]";

const CARD_RUN = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;

export function redactCardNumbers(text: string): string {
  return text.replace(CARD_RUN, REDACTED_CARD);
}
