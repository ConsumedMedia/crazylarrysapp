/**
 * Browser-side card tokenization, shared by /book (PaymentForm) and /pay.
 *
 * PCI note: the card values are sent by fetch() DIRECTLY to Intuit's
 * tokenization endpoint (`tokenizeUrl`). The only thing that ever reaches our
 * server is the opaque token string. Card number / CVC / expiry are never in
 * a request to our backend, never logged. Pure: no React, no server imports.
 */

export interface CardValues {
  name: string;
  number: string;
  expMonth: string;
  expYear: string;
  cvc: string;
  zip: string;
}

export function onlyDigits(s: string): string {
  return s.replace(/\D+/g, "");
}

export function cardLooksValid(c: CardValues): boolean {
  return (
    c.name.trim().length > 1 &&
    onlyDigits(c.number).length >= 13 &&
    /^\d{1,2}$/.test(c.expMonth) &&
    Number(c.expMonth) >= 1 &&
    Number(c.expMonth) <= 12 &&
    /^\d{2}$/.test(c.expYear) &&
    onlyDigits(c.cvc).length >= 3 &&
    onlyDigits(c.zip).length >= 5
  );
}

/** POST the card to Intuit; resolve to the token value or throw a customer-readable Error. */
export async function tokenizeCard(tokenizeUrl: string, c: CardValues): Promise<string> {
  const res = await fetch(tokenizeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      card: {
        name: c.name.trim(),
        number: onlyDigits(c.number),
        expMonth: c.expMonth.padStart(2, "0"),
        expYear: `20${c.expYear}`,
        cvc: onlyDigits(c.cvc),
        address: {
          postalCode: onlyDigits(c.zip),
          country: "US",
        },
      },
    }),
  });
  if (!res.ok) {
    let msg = "We couldn't read that card. Check the number and try again.";
    try {
      const j = await res.json();
      if (j?.errors?.[0]?.detail) msg = `Card error: ${j.errors[0].detail}`;
    } catch {
      /* keep default */
    }
    throw new Error(msg);
  }
  const j = await res.json();
  if (!j?.value) throw new Error("Card tokenization failed. Try again.");
  return j.value as string;
}
