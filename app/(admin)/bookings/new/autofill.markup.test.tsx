/**
 * /bookings/new customer autofill markup: the results list in every state,
 * the picked-customer banner, address options (offered, never filled), the
 * consent line beside an always-unticked box, and the edit warnings — in the
 * off form and the pay-link form.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formHooksMock } from "@/test/form-hooks";
import type { PickedCustomer } from "@/lib/customers/search-shared";
import { AddressOptions, ConsentOnFile, EditWarnings, PickedBanner, SearchResults } from "./_components/CustomerAutofill";
import { editWarnings } from "@/lib/customers/autofill";

vi.mock("react-dom", async (orig) => formHooksMock(await orig<object>()));
vi.mock("@/lib/auth/requireStaff", () => ({ requireStaff: async () => ({ userId: "s", role: "owner" }) }));
vi.mock("@/app/(customer)/book/_components/AvailabilityCalendar", () => ({ AvailabilityCalendar: () => <div data-stub="calendar" /> }));
vi.mock("../actions", () => ({ createStaffBookingAction: vi.fn() }));
vi.mock("./pay-link-actions", () => ({ createPayLinkBookingAction: vi.fn() }));
vi.mock("./customer-actions", () => ({ searchCustomersAction: vi.fn(), pickCustomerAction: vi.fn(), emailOwnerAction: vi.fn() }));
let enabled = false;
vi.mock("@/lib/pay-links/settings", () => ({ getPayLinkSettings: async () => ({ enabled }) }));
// The order cutoff (pay-link button only): a fake, so no test reaches the database.
vi.mock("@/lib/bookings/cutoff", async () => {
  const shared = await import("@/lib/bookings/cutoff-shared");
  return { ...shared, getDeliveryFloor: async () => shared.fallbackFloor() };
});
vi.mock("@/lib/bookings/pricing", () => ({
  getPricingConfig: async () => ({
    sizes: [{ size: "15yd", base_price: 350, included_days: 7, included_tons: 2, is_active: true }],
    settings: { tax_rate: 0.0725 },
    bookingReady: true,
  }),
}));
let customer: PickedCustomer | null = null;
vi.mock("@/lib/customers/search", () => ({ pickCustomer: async () => customer }));

const ID = "11111111-1111-4111-8111-111111111111";
const PICKED: PickedCustomer = {
  id: ID,
  name: "Pat Example",
  email: "pat@crazylarrys.test",
  phone: "614-555-0142",
  company: "Example Roofing",
  bookings: 3,
  addresses: [
    { label: "1 Test St, Columbus, OH 43004", parts: { street: "1 Test St", city: "Columbus", state: "OH", zip: "43004" } },
    { label: "Lot 4 behind the barn", parts: null },
  ],
  consent: { onFile: true, last: { granted: true, source: "phone_verbal", recordedAt: "2026-11-03T15:00:00Z" } },
};

async function page(id?: string) {
  const { default: Page } = await import("./page");
  return renderToStaticMarkup(await Page({ searchParams: id ? { customer: id } : {} }));
}
const r = (el: React.ReactElement) => renderToStaticMarkup(el);

beforeEach(() => {
  enabled = false;
  customer = PICKED;
});

describe("search results", () => {
  const hits = [
    { id: "a", name: "Pat Example", phone: "614-555-0142", company: "Example Roofing", bookings: 3 },
    { id: "b", name: "Patsy Two", phone: null, company: null, bookings: 1 },
  ];
  it("up to 8 rows with name, phone, company and booking count; the active one selected", () => {
    const html = r(<SearchResults state={{ status: "results", hits }} activeIndex={1} onPick={() => {}} />);
    expect(html).toContain('role="listbox"');
    expect(html).toContain("Pat Example");
    expect(html).toContain(" · 614-555-0142");
    expect(html).toContain(" · Example Roofing");
    expect(html).toContain("· 3 bookings");
    expect(html).toContain("· 1 booking<");
    expect(html).toMatch(/id="customer-search-results-1" role="option" aria-selected="true"/);
  });
  it("loading, nothing found, search unavailable, idle", () => {
    expect(r(<SearchResults state={{ status: "loading" }} activeIndex={-1} onPick={() => {}} />)).toContain("Searching…");
    expect(r(<SearchResults state={{ status: "empty" }} activeIndex={-1} onPick={() => {}} />)).toContain("No match — this will be a new customer.");
    expect(r(<SearchResults state={{ status: "error" }} activeIndex={-1} onPick={() => {}} />)).toContain("Search isn&#x27;t available — type the details.");
    expect(r(<SearchResults state={{ status: "idle" }} activeIndex={-1} onPick={() => {}} />)).toBe("");
  });
});

describe("pieces", () => {
  it("banner: existing customer, booking count, Not this customer", () => {
    const html = r(<PickedBanner picked={PICKED} onClear={() => {}} />);
    expect(html).toContain("Existing customer");
    expect(html).toContain("· 3 bookings");
    expect(html).toContain("Not this customer");
  });
  it("addresses: usable ones are buttons; unsplittable ones disabled with 'type it'; plus New address", () => {
    const html = r(<AddressOptions options={PICKED.addresses} onUse={() => {}} onNew={() => {}} />);
    expect(html).toMatch(/<button type="button" class="[^"]*">1 Test St, Columbus, OH 43004<\/button>/);
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>Lot 4 behind the barn — type it<\/button>/);
    expect(html).toContain(">New address</button>");
  });
  it("consent on file", () => {
    expect(r(<ConsentOnFile consent={PICKED.consent} />)).toContain("On file: agreed to texts (by phone, Nov 3)");
  });
  it("email warning names the other customer only — never their email or phone", () => {
    const html = r(<EditWarnings warnings={editWarnings(PICKED, { name: PICKED.name, phone: PICKED.phone!, email: "lee@crazylarrys.test", company: PICKED.company! }, "Lee Prepaid")} />);
    expect(html).toContain("That email already belongs to another customer: Lee Prepaid.");
    expect(html).not.toContain("lee@");
  });
});

for (const on of [false, true]) {
  describe(`picked customer (?customer=) with pay links ${on ? "ON" : "OFF"}`, () => {
    beforeEach(() => {
      enabled = on;
    });
    it("fills name/phone/email/company and the hidden id; offers addresses but leaves every address field empty", async () => {
      const html = await page(ID);
      expect(html).toContain(`name="customerId" value="${ID}"`);
      expect(html).toMatch(/name="contactName"[^>]*value="Pat Example"/);
      expect(html).toMatch(/name="contactEmail"[^>]*value="pat@crazylarrys.test"/);
      expect(html).toMatch(/name="companyName"[^>]*value="Example Roofing"/);
      expect(html).toContain('data-testid="address-options"');
      for (const f of ["street", "city", "zip"]) expect(html).toMatch(new RegExp(`name="${f}"[^>]*value=""`));
      expect(html).toMatch(/name="state"[^>]*value="OH"/);
    });
    it("texts box unticked although they agreed before, with the answer on file beside it", async () => {
      const html = await page(ID);
      expect(html).toMatch(/<input type="checkbox" name="smsConsent" class="[^"]*"\/>/);
      expect(html).not.toMatch(/name="smsConsent"[^>]*checked/);
      expect(html).toContain("On file: agreed to texts (by phone, Nov 3)");
      if (on) expect(html).toContain("Can we text you the payment link");
    });
    it("no warnings until something is edited", async () => {
      expect(await page(ID)).not.toContain("edit-warnings");
    });
  });
}

describe("no customer", () => {
  it("search attributes on name and phone; no banner, no addresses, no consent line, no hidden id", async () => {
    const html = await page();
    expect(html).toMatch(/name="contactName"[^>]*role="combobox"[^>]*aria-expanded="false"/);
    expect(html).toMatch(/name="contactPhone"[^>]*role="combobox"/);
    expect(html).not.toContain("picked-customer");
    expect(html).not.toContain("address-options");
    expect(html).not.toContain("consent-on-file");
    expect(html).not.toContain('name="customerId"');
  });
  it("a malformed ?customer= is ignored, not looked up", async () => {
    const html = await page("not-a-uuid");
    expect(html).not.toContain('name="customerId"');
  });
});
