/**
 * Which wizard step owns a refused checkout, so the customer lands where they
 * can fix it. `code` is CheckoutResult.code; for "compensated" (charged, then
 * refused by the database and refunded) `reason` says why.
 *
 *   step 1 Size, step 2 Dates, step 3 Details; null = stay on Review & pay.
 * `clearDate` drops the picked date so a refused day can't be resubmitted.
 */
export function refusalStep(
  code: string | undefined,
  reason?: string,
): { step: 1 | 2 | 3 | null; clearDate: boolean } {
  const why = code === "compensated" ? reason : code;
  switch (why) {
    case "bad_size":
      return { step: 1, clearDate: false };
    case "bad_date":
    case "past_date":
    case "blocked":
    case "unavailable":
      return { step: 2, clearDate: true };
    case "bad_address":
    case "bad_contact":
    case "no_contact":
    case "bad_email":
      // Only an early refusal can carry these; the database never does.
      return code === "compensated" ? { step: null, clearDate: false } : { step: 3, clearDate: false };
    default:
      return { step: null, clearDate: false };
  }
}
