/**
 * The /settings banner: what /book uses right now, and why; warning tone when
 * Settings and the deployment disagree or the setting can't be read.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgreementModeBanner } from "./AgreementModeBanner";
import type { AgreementStatus } from "@/lib/docusign/mode-shared";

const capOk = { enabled: true, missing: [], ok: true };
const capNo = { enabled: false, missing: ["DOCUSIGN_TEMPLATE_ID"], ok: false };
const render = (s: AgreementStatus) => renderToStaticMarkup(<AgreementModeBanner status={s} />);

describe("agreement mode banner", () => {
  it.each([
    [{ setting: "attest", capability: capNo, effective: "attest" }, "neutral", "status", "PowerForm and checkbox."],
    [{ setting: "attest", capability: capOk, effective: "attest" }, "neutral", "status", "PowerForm and checkbox."],
    [{ setting: "docusign", capability: capOk, effective: "docusign" }, "on", "status", "DocuSign."],
    [{ setting: "docusign", capability: capNo, effective: "attest" }, "warn", "alert", "missing DOCUSIGN_TEMPLATE_ID"],
    [{ setting: null, capability: capOk, effective: "attest" }, "warn", "alert", "couldn&#x27;t be read"],
  ] as const)("%j -> %s", (s, tone, role, text) => {
    const html = render(s as AgreementStatus);
    expect(html).toContain(`data-tone="${tone}"`);
    expect(html).toContain(`role="${role}"`);
    expect(html).toContain(text);
    expect(html).toContain('href="#agreement"');
  });
});
