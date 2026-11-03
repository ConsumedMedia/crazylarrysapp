/**
 * Pins the exact HTML /book's PaymentForm renders, so pulling the card fields
 * into a shared hook (for /pay) is provably no change to /book. The snapshot
 * was written BEFORE that refactor.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../actions", () => ({ payAndBookAction: vi.fn() }));

import { PaymentForm } from "./PaymentForm";

const base = {
  tokenizeUrl: "https://sandbox.api.intuit.com/quickbooks/v4/payments/tokens",
  buildInput: () => null,
  onRefused: () => false,
};

describe("/book PaymentForm markup", () => {
  it("ready to pay, with a total", () => {
    expect(renderToStaticMarkup(<PaymentForm {...base} total={402.05} disabled={false} />)).toMatchSnapshot();
  });
  it("disabled with a reason", () => {
    expect(
      renderToStaticMarkup(<PaymentForm {...base} total={402.05} disabled disabledReason="Open the agreement first." />),
    ).toMatchSnapshot();
  });
  it("no total yet", () => {
    expect(renderToStaticMarkup(<PaymentForm {...base} total={null} disabled={false} />)).toMatchSnapshot();
  });
});
