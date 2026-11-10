/**
 * Compile-time test: createBooking accepts only what normalizeBookingInput
 * returns (ValidatedBookingParams). The real assertions are the
 * `@ts-expect-error` lines, checked by `tsc --noEmit` (the first step of
 * `npm run verify`). If the brand is removed from normalizeBookingInput's
 * return type or from createBooking's parameter, or ValidatedBookingParams is
 * loosened to the plain interface, those lines stop being errors and tsc fails
 * with TS2578 "Unused '@ts-expect-error' directive".
 *
 * The runtime part checks the brand adds nothing to the object: same keys, no
 * symbols, so the RPC call is unchanged. createBooking itself is never called
 * (it's imported as a type only); `accepts` stands in for its parameter.
 *
 * No casts are needed here, so there is no test-only cast helper.
 */
import { describe, it, expect } from "vitest";
import { normalizeBookingInput, type NormalizedBookingParams } from "./create";
import type { createBooking } from "./create";
import type { CreateBookingInput } from "./types";

/** Exactly createBooking's parameter type, without calling it. */
type CreateBookingParams = Parameters<typeof createBooking>[0];
const accepts = (params: CreateBookingParams): CreateBookingParams => params;

const input: CreateBookingInput = {
  size: "20yd",
  deliveryDate: "2099-01-04",
  street: "1 Test St",
  city: "Columbus",
  state: "OH",
  zip: "43215",
  contactName: "Brand Test",
  contactEmail: "brand-test@example.com",
};

const EXPECTED_KEYS = [
  "p_company_name",
  "p_contact_email",
  "p_contact_name",
  "p_contact_phone",
  "p_debris_type",
  "p_delivery_address",
  "p_delivery_date",
  "p_placement_notes",
  "p_rental_days",
  "p_size",
  "p_sms_consent",
];

describe("ValidatedBookingParams: only normalizeBookingInput produces createBooking's input", () => {
  const validated = normalizeBookingInput(input);

  it("accepts the output of normalizeBookingInput", () => {
    expect(accepts(validated)).toBe(validated);
  });

  it("rejects a plain object, a spread copy, a spread with an override and a plain-typed value (compile time)", () => {
    const plain: NormalizedBookingParams = {
      p_size: "20yd",
      p_delivery_date: "2099-01-04",
      p_delivery_address: "1 Test St, Columbus, OH 43215",
      p_contact_name: "Brand Test",
      p_rental_days: 7,
      p_placement_notes: null,
      p_debris_type: null,
      p_contact_email: "brand-test@example.com",
      p_contact_phone: null,
      p_company_name: null,
      p_sms_consent: false,
    };
    // @ts-expect-error a hand-built object never went through normalizeBookingInput
    accepts(plain);
    // @ts-expect-error a spread copy drops the brand
    accepts({ ...validated });
    // @ts-expect-error a spread copy with a changed date (the case the brand exists for)
    accepts({ ...validated, p_delivery_date: "2000-01-01" });
    const widened: NormalizedBookingParams = validated;
    // @ts-expect-error a value typed as the plain interface, even if it came from normalizeBookingInput
    accepts(widened);
    // @ts-expect-error a look-alike with a key named like the brand
    accepts({ ...plain, validatedByNormalizeBookingInput: true as const });
    expect(true).toBe(true);
  });

  it("adds nothing at runtime: same keys, no symbols, plain JSON for the RPC", () => {
    expect(Object.keys(validated).sort()).toEqual(EXPECTED_KEYS);
    expect(Object.getOwnPropertySymbols(validated)).toEqual([]);
    expect(Object.getPrototypeOf(validated)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(validated))).toEqual({ ...validated });
  });
});
