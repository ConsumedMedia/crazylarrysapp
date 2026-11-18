/**
 * Unit test — the two-key agreement switch (docusign-port, task 4). DocuSign
 * only when the owner's setting says docusign AND this deployment has
 * CL_DOCUSIGN_ENABLED=1 plus every DOCUSIGN_* variable; everything else,
 * read failures included, is attest. Supabase is a fake; no DocuSign call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({ rpc: (fn: string) => m.rpc(fn) }),
}));

import {
  agreementBanner,
  docusignCapability,
  effectiveAgreementMode,
  getAgreementStatus,
  readAgreementSetting,
  resolveEffectiveMode,
} from "./mode";

const VARS = [
  "DOCUSIGN_AUTH_SERVER",
  "DOCUSIGN_BASE_PATH",
  "DOCUSIGN_INTEGRATION_KEY",
  "DOCUSIGN_USER_ID",
  "DOCUSIGN_ACCOUNT_ID",
  "DOCUSIGN_TEMPLATE_ID",
  "DOCUSIGN_PRIVATE_KEY_B64",
];
const saved: Record<string, string | undefined> = {};
function setEnv(enabled: string | undefined, missing: string[] = []) {
  if (enabled === undefined) delete process.env.CL_DOCUSIGN_ENABLED;
  else process.env.CL_DOCUSIGN_ENABLED = enabled;
  for (const k of VARS) {
    if (missing.includes(k)) delete process.env[k];
    else process.env[k] = "test-value";
  }
}

beforeEach(() => {
  for (const k of ["CL_DOCUSIGN_ENABLED", ...VARS]) saved[k] = process.env[k];
  m.rpc.mockReset();
  m.rpc.mockResolvedValue({ data: "attest", error: null });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("resolveEffectiveMode: docusign only when both keys say so", () => {
  it.each([
    ["docusign", true, "docusign"],
    ["docusign", false, "attest"],
    ["attest", true, "attest"],
    ["attest", false, "attest"],
    [null, true, "attest"],
    [null, false, "attest"],
  ] as const)("setting %s, capability %s -> %s", (setting, ok, want) => {
    expect(resolveEffectiveMode(setting, { ok })).toBe(want);
  });
});

describe("docusignCapability", () => {
  it("CL_DOCUSIGN_ENABLED=1 and every DOCUSIGN_* -> ok", () => {
    setEnv("1");
    expect(docusignCapability()).toEqual({ enabled: true, missing: [], ok: true });
  });
  it.each([undefined, "", "0", "true", "yes", "11"])("CL_DOCUSIGN_ENABLED=%s -> not ok, even with every credential", (v) => {
    setEnv(v);
    expect(docusignCapability()).toMatchObject({ enabled: false, ok: false });
  });
  it("' 1 ' (stray spaces) counts as 1", () => {
    setEnv(" 1 ");
    expect(docusignCapability().ok).toBe(true);
  });
  it.each(VARS)("missing %s -> not ok, and named", (k) => {
    setEnv("1", [k]);
    expect(docusignCapability()).toEqual({ enabled: true, missing: [k], ok: false });
  });
});

describe("effectiveAgreementMode", () => {
  it("capability missing: attest without reading the setting", async () => {
    setEnv(undefined);
    m.rpc.mockResolvedValue({ data: "docusign", error: null });
    expect(await effectiveAgreementMode()).toBe("attest");
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("capability present, setting docusign: docusign (reads booking_agreement_mode)", async () => {
    setEnv("1");
    m.rpc.mockResolvedValue({ data: "docusign", error: null });
    expect(await effectiveAgreementMode()).toBe("docusign");
    expect(m.rpc).toHaveBeenCalledWith("booking_agreement_mode");
  });
  it("capability present, setting attest: attest", async () => {
    setEnv("1");
    expect(await effectiveAgreementMode()).toBe("attest");
  });
  it.each([
    ["an error (function not there yet: migration not applied)", () => m.rpc.mockResolvedValue({ data: null, error: { message: "not found" } })],
    ["a throw", () => m.rpc.mockRejectedValue(new Error("network"))],
    ["an unexpected value", () => m.rpc.mockResolvedValue({ data: "DocuSign", error: null })],
    ["null", () => m.rpc.mockResolvedValue({ data: null, error: null })],
  ])("setting unreadable (%s): attest", async (_label, arrange) => {
    setEnv("1");
    arrange();
    expect(await readAgreementSetting()).toBeNull();
    expect(await effectiveAgreementMode()).toBe("attest");
  });
});

describe("the staff banner", () => {
  it("docusign in effect", async () => {
    setEnv("1");
    m.rpc.mockResolvedValue({ data: "docusign", error: null });
    const b = agreementBanner(await getAgreementStatus());
    expect(b.tone).toBe("on");
    expect(b.text).toMatch(/^Online rental agreement: DocuSign\./);
  });
  it("attest set, attest in effect", async () => {
    setEnv(undefined);
    const b = agreementBanner(await getAgreementStatus());
    expect(b).toEqual({ tone: "neutral", text: "Online rental agreement: PowerForm and checkbox." });
  });
  it("docusign set but this deployment can't: a warning naming what's missing, never values", async () => {
    setEnv(undefined, ["DOCUSIGN_TEMPLATE_ID"]);
    process.env.DOCUSIGN_PRIVATE_KEY_B64 = "SECRET-SHOULD-NOT-APPEAR";
    m.rpc.mockResolvedValue({ data: "docusign", error: null });
    const s = await getAgreementStatus();
    expect(s.effective).toBe("attest");
    const b = agreementBanner(s);
    expect(b.tone).toBe("warn");
    expect(b.text).toContain("Settings say DocuSign");
    expect(b.text).toContain("CL_DOCUSIGN_ENABLED is not 1");
    expect(b.text).toContain("missing DOCUSIGN_TEMPLATE_ID");
    expect(b.text).not.toContain("SECRET");
    expect(b.text).toContain("/book uses the PowerForm");
  });
  it("setting unreadable: a warning, attest", async () => {
    setEnv("1");
    m.rpc.mockResolvedValue({ data: null, error: { message: "x" } });
    const b = agreementBanner(await getAgreementStatus());
    expect(b.tone).toBe("warn");
    expect(b.text).toContain("couldn't be read");
  });
});
