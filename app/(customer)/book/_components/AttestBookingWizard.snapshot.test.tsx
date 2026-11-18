/**
 * /book in attest mode, pinned: the wizard's markup at every step, the
 * PowerForm modal opened and ticked, and what the payment step would submit.
 *
 * The snapshot file was produced by running this same test against
 * users-page's own BookingWizard (scratch export of users-page, import line
 * pointed at "./BookingWizard"), and it is byte-identical to the one this
 * test writes for AttestBookingWizard on docusign-port. Real wizard and modal
 * through test/mini-render; the calendar and the card form are stubs that
 * record their props.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createElement } from "react";
import { mount, type Host } from "@/test/mini-render";
import type { PricingConfig } from "@/lib/bookings/pricing";

vi.mock("react", async (orig) => {
  const { hooks } = await import("@/test/mini-render");
  return { ...(await orig<object>()), ...hooks };
});

beforeAll(() => {
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

let calendar: { onSelectDate: (d: string) => void } | null = null;
vi.mock("./AvailabilityCalendar", () => ({
  AvailabilityCalendar: (p: { onSelectDate: (d: string) => void }) => {
    calendar = p;
    return null;
  },
}));
let payment: Record<string, unknown> | null = null;
vi.mock("./PaymentForm", () => ({
  PaymentForm: (p: Record<string, unknown>) => {
    payment = p;
    return null;
  },
}));

import { AttestBookingWizard as Wizard } from "./AttestBookingWizard";

const pricing = {
  sizes: (["10yd", "15yd", "20yd"] as const).map((size, i) => ({
    size,
    base_price: 350 + i * 50,
    included_days: 5,
    included_tons: 1,
    is_active: true,
  })),
  settings: { extra_day_rate: 25, overage_ton_rate: 60, credit_card_fee_rate: 0.03, driveway_fee_rate: 0, tax_rate: 0.0725 },
  bookingReady: true,
} as unknown as PricingConfig;

/** Every host element in order: tag, its non-function props, its direct text. */
function serialize(hosts: Host[]): string {
  return hosts
    .map((h) => {
      const props = Object.entries(h.props)
        .filter(([k, v]) => k !== "children" && typeof v !== "function")
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");
      const kids = ([] as unknown[]).concat(h.props.children ?? []);
      const text = kids.filter((k) => typeof k === "string" || typeof k === "number").join("");
      return `<${h.type}${props ? " " + props : ""}>${text}`;
    })
    .join("\n");
}

const paymentProps = () =>
  payment && {
    tokenizeUrl: payment.tokenizeUrl,
    total: payment.total,
    disabled: payment.disabled,
    disabledReason: payment.disabledReason,
    submits: (payment.buildInput as () => unknown)(),
  };

describe("/book attest wizard (users-page's BookingWizard)", () => {
  it("every step, the PowerForm modal, and what it submits", () => {
    const m = mount(() =>
      createElement(Wizard, {
        pricing,
        docusignUrl: "https://powerform.test/agreement",
        tokenizeUrl: "https://tokenize.test/tokens",
        paymentsReady: true,
      }),
    );
    expect(serialize(m.hosts())).toMatchSnapshot("1 size");

    const checks = m.hosts().filter((h) => h.type === "button" && h.text.includes("Check dates"));
    (checks[2].props.onClick as () => void)(); // 20 yd
    expect(serialize(m.hosts())).toMatchSnapshot("2 dates, none picked");
    calendar!.onSelectDate("2026-12-01");
    expect(serialize(m.hosts())).toMatchSnapshot("2 dates, picked");

    m.click("Continue to details");
    expect(serialize(m.hosts())).toMatchSnapshot("3 details, empty");
    const values = ["1 Test St", "Columbus", "OH", "43215", "Snap Test", "614-321-7654", "snap@crazylarrys.test", "Snap Co"];
    let i = 0;
    for (const h of m.hosts()) {
      if ((h.type !== "input" && h.type !== "textarea") || h.props.type === "checkbox" || typeof h.props.onChange !== "function") continue;
      const value = values[i++] ?? `note ${i}`;
      (h.props.onChange as (e: unknown) => void)({ target: { value }, currentTarget: { value } });
    }
    expect(serialize(m.hosts())).toMatchSnapshot("3 details, filled");

    m.click("Review & pay");
    expect(serialize(m.hosts())).toMatchSnapshot("4 review, not signed");
    expect(paymentProps()).toMatchSnapshot("4 payment props, not signed");

    m.click("Read & sign");
    expect(serialize(m.hosts())).toMatchSnapshot("4 PowerForm modal open");
    const box = m.hosts().find((h) => h.type === "input" && h.props.type === "checkbox" && h.props.checked === false && typeof h.props.onChange === "function");
    (box!.props.onChange as (e: unknown) => void)({ target: { checked: true }, currentTarget: { checked: true } });
    expect(serialize(m.hosts())).toMatchSnapshot("4 PowerForm modal ticked");
    expect(paymentProps()).toMatchSnapshot("4 payment props, acknowledged");
  });
});
