/**
 * The pay-link contact rule, shared by the Book form (to disable the button)
 * and the server (which checks again; the RPC checks a third time): an email,
 * or a phone number with the customer's verbal OK to texts.
 */
export function reachable(input: { contactEmail?: string; contactPhone?: string; smsConsent?: boolean }): boolean {
  const email = (input.contactEmail ?? "").trim();
  const phone = (input.contactPhone ?? "").trim();
  return email.length > 0 || (phone.length > 0 && input.smsConsent === true);
}

export const NO_REACHABLE_CONTACT =
  "Add an email, or a phone number and tick that the customer agreed to texts — otherwise we can't send the pay link.";

/**
 * A pay-link token anywhere in a string (bare, or inside a /pay/ URL), replaced
 * with "…". For error text that reaches the screen, a log or the console.
 */
export function scrubPayTokens(text: string): string {
  return text.replace(/(^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, "$1…");
}
