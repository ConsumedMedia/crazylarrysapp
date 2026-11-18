/**
 * /book renders users-page's wizard (AttestBookingWizard, with the PowerForm
 * link) unless the effective mode is docusign. The wizards are stubs that
 * record their props; the mode is a fake.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const m = vi.hoisted(() => ({
  mode: "attest" as "attest" | "docusign",
  attest: null as Record<string, unknown> | null,
  docusign: null as Record<string, unknown> | null,
}));
vi.mock("@/lib/docusign/mode", () => ({ effectiveAgreementMode: async () => m.mode }));
vi.mock("@/lib/docusign/config", () => ({ docusignConfigured: () => true }));
vi.mock("@/lib/quickbooks/config", () => ({ quickBooksConfigured: () => true }));
vi.mock("@/lib/bookings/pricing", () => ({ getPricingConfig: async () => ({ sizes: [], settings: {}, bookingReady: true }) }));
vi.mock("./_components/AttestBookingWizard", () => ({
  AttestBookingWizard: (p: Record<string, unknown>) => ((m.attest = p), <div data-wizard="attest" />),
}));
vi.mock("./_components/BookingWizard", () => ({
  BookingWizard: (p: Record<string, unknown>) => ((m.docusign = p), <div data-wizard="docusign" />),
}));

import BookPage from "./page";

let savedUrl: string | undefined;
beforeEach(() => {
  m.attest = m.docusign = null;
  savedUrl = process.env.NEXT_PUBLIC_DOCUSIGN_URL;
  process.env.NEXT_PUBLIC_DOCUSIGN_URL = "https://powerform.test/pf";
});
afterEach(() => {
  if (savedUrl === undefined) delete process.env.NEXT_PUBLIC_DOCUSIGN_URL;
  else process.env.NEXT_PUBLIC_DOCUSIGN_URL = savedUrl;
});

describe("/book picks the wizard by the effective mode", () => {
  it("attest: users-page's wizard with the PowerForm link, never the DocuSign one", async () => {
    m.mode = "attest";
    const html = renderToStaticMarkup(await BookPage());
    expect(html).toContain('data-wizard="attest"');
    expect(m.docusign).toBeNull();
    expect(m.attest).toMatchObject({ docusignUrl: "https://powerform.test/pf", paymentsReady: true });
    expect(m.attest).not.toHaveProperty("agreementsEnabled");
  });
  it("attest without the PowerForm variable: null, as users-page", async () => {
    m.mode = "attest";
    delete process.env.NEXT_PUBLIC_DOCUSIGN_URL;
    await BookPage().then(renderToStaticMarkup);
    expect(m.attest).toMatchObject({ docusignUrl: null });
  });
  it("docusign: the DocuSign wizard, no PowerForm link", async () => {
    m.mode = "docusign";
    const html = renderToStaticMarkup(await BookPage());
    expect(html).toContain('data-wizard="docusign"');
    expect(m.attest).toBeNull();
    expect(m.docusign).toMatchObject({ agreementsEnabled: true });
    expect(m.docusign).not.toHaveProperty("docusignUrl");
  });
});
