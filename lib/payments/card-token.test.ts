/**
 * The tokenize request PaymentForm sent before the refactor, field for field:
 * digits only, two-digit month, 20YY, trimmed name, US postal code, and only
 * to the Intuit URL it was given. fetch is stubbed — nothing leaves the machine.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cardLooksValid, tokenizeCard } from "./card-token";

const URL = "https://sandbox.api.intuit.com/quickbooks/v4/payments/tokens";
const CARD = { name: "  Pat Smith ", number: "4111 1111-1111 1111", expMonth: "9", expYear: "30", cvc: "1 23", zip: "43004-1234" };

afterEach(() => vi.unstubAllGlobals());

describe("tokenizeCard", () => {
  it("posts exactly the old body to the given Intuit URL and returns the token", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- params type mock.calls[n]
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ value: "tok-1" }), { status: 201 }));
    vi.stubGlobal("fetch", f);
    expect(await tokenizeCard(URL, CARD)).toBe("tok-1");
    expect(f).toHaveBeenCalledTimes(1);
    const [u, init] = f.mock.calls[0];
    expect(u).toBe(URL);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      card: { name: "Pat Smith", number: "4111111111111111", expMonth: "09", expYear: "2030", cvc: "123", address: { postalCode: "430041234", country: "US" } },
    });
  });

  it("shows Intuit's detail on a refused card", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [{ detail: "card.number is invalid" }] }), { status: 400 })));
    await expect(tokenizeCard(URL, CARD)).rejects.toThrow("Card error: card.number is invalid");
  });

  it("no token value -> a retry message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 201 })));
    await expect(tokenizeCard(URL, CARD)).rejects.toThrow("Card tokenization failed. Try again.");
  });
});

describe("cardLooksValid", () => {
  it("same rules as before", () => {
    const ok = { name: "Pat", number: "4111111111111", expMonth: "12", expYear: "30", cvc: "123", zip: "43004" };
    expect(cardLooksValid(ok)).toBe(true);
    expect(cardLooksValid({ ...ok, name: "P" })).toBe(false);
    expect(cardLooksValid({ ...ok, number: "411111111111" })).toBe(false);
    expect(cardLooksValid({ ...ok, expMonth: "13" })).toBe(false);
    expect(cardLooksValid({ ...ok, expMonth: "0" })).toBe(false);
    expect(cardLooksValid({ ...ok, expYear: "3" })).toBe(false);
    expect(cardLooksValid({ ...ok, cvc: "12" })).toBe(false);
    expect(cardLooksValid({ ...ok, zip: "4300" })).toBe(false);
  });
});
