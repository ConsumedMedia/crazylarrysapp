/**
 * Settings → Rental agreement panel markup: owners get the two radios, staff
 * a read-only line, everyone the "Check DocuSign" button; the capability gap is
 * named (never values); an unreadable setting warns and offers no form.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formHooksMock, formStateFor } from "@/test/form-hooks";
import type { AgreementStatus } from "@/lib/docusign/mode-shared";

vi.mock("react-dom", async (orig) => formHooksMock(await orig<object>()));
vi.mock("../actions", () => ({ saveAgreementModeAction: vi.fn(), checkDocusignAction: vi.fn() }));

import { checkDocusignAction } from "../actions";
import { AgreementModePanel } from "./AgreementModeSettings";

const status = (over: Partial<AgreementStatus> = {}): AgreementStatus => ({
  setting: "attest",
  capability: { enabled: false, missing: ["DOCUSIGN_TEMPLATE_ID"], ok: false },
  effective: "attest",
  ...over,
});
const render = (s: AgreementStatus, canEdit: boolean) => renderToStaticMarkup(<AgreementModePanel status={s} canEdit={canEdit} />);

describe("Rental agreement panel", () => {
  it("owner, attest: both radios, attest checked, the gap named", () => {
    const html = render(status(), true);
    expect(html).toMatch(/name="agreement_mode" checked="" value="attest"/);
    expect(html).toMatch(/<input type="radio" name="agreement_mode" value="docusign"\/>/);
    expect(html).toContain("not set up for DocuSign (CL_DOCUSIGN_ENABLED is not 1; missing DOCUSIGN_TEMPLATE_ID)");
    expect(html).toContain("Save rental agreement");
    expect(html).toContain("Check DocuSign");
    expect(html).toContain(">PowerForm and checkbox</span>");
  });
  it("owner, docusign in effect: the pill says DocuSign", () => {
    const html = render(status({ setting: "docusign", effective: "docusign", capability: { enabled: true, missing: [], ok: true } }), true);
    expect(html).toContain(">DocuSign</span>");
    expect(html).toContain("set up for DocuSign.");
    expect(html).toMatch(/checked="" value="docusign"/);
  });
  it("staff: read-only, no radios, still the check", () => {
    const html = render(status({ setting: "docusign" }), false);
    expect(html).not.toContain('name="agreement_mode"');
    expect(html).toContain("Set to DocuSign.");
    expect(html).toContain("only an owner can change it");
    expect(html).toContain("Check DocuSign");
  });
  it("setting unreadable: a warning, no form", () => {
    const html = render(status({ setting: null }), true);
    expect(html).not.toContain('name="agreement_mode"');
    expect(html).toContain("couldn&#x27;t be read");
  });
  it("preflight result: each step with its detail", () => {
    formStateFor.set(checkDocusignAction, {
      ran: true,
      result: {
        ok: false,
        environment: "production",
        checkedAt: "2026-11-17T12:00:00.000Z",
        steps: [
          { key: "switch", label: "Switched on for this deployment", ok: true, detail: "CL_DOCUSIGN_ENABLED is 1." },
          { key: "role", label: "Signer role “Renter”", ok: false, detail: "Not found." },
        ],
      },
    });
    const html = render(status(), false);
    expect(html).toContain("Not ready · production");
    expect(html).toContain("✓ Switched on for this deployment");
    expect(html).toContain("✗ Signer role “Renter”");
    formStateFor.clear();
  });
});
