/**
 * Unit test — "Check DocuSign" (lib/docusign/preflight). DocuSign is a fake:
 * no network. Each failure stops the steps after it, the role must be exactly
 * "Renter", and nothing secret reaches the result.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  cap: { enabled: true, missing: [] as string[], ok: true },
  config: vi.fn(),
  token: vi.fn(),
  json: vi.fn(),
}));
vi.mock("./mode", () => ({ docusignCapability: () => m.cap }));
vi.mock("./config", () => ({ getDocusignConfig: () => m.config() }));
vi.mock("./auth", () => ({ getDocusignAccessToken: () => m.token() }));
vi.mock("./client", () => ({ docusignJson: (p: string) => m.json(p) }));
vi.mock("./envelopes", () => ({ AGREEMENT_ROLE: "Renter" }));

import { runDocusignPreflight } from "./preflight";

const SECRET_TOKEN = "eyJ-SECRET-ACCESS-TOKEN";
const SECRET_KEY = "-----BEGIN PRIVATE KEY-----SECRET";
const now = () => new Date("2026-11-17T12:00:00Z");

beforeEach(() => {
  m.cap = { enabled: true, missing: [], ok: true };
  m.config.mockReset().mockReturnValue({
    environment: "sandbox",
    authHost: "account-d.docusign.com",
    apiBase: "https://demo.docusign.net/restapi/v2.1/accounts/acc-1",
    templateId: "tpl-1",
    privateKeyPem: SECRET_KEY,
  });
  m.token.mockReset().mockResolvedValue(SECRET_TOKEN);
  m.json.mockReset().mockImplementation(async (p: string) =>
    p.endsWith("/recipients") ? { signers: [{ roleName: "Renter" }] } : { templateId: "tpl-1", name: "Rental Agreement" },
  );
});

const keys = (r: Awaited<ReturnType<typeof runDocusignPreflight>>) => r.steps.map((s) => `${s.key}:${s.ok ? "ok" : "no"}`);

describe("Check DocuSign", () => {
  it("all good: six steps ok, sandbox, read-only calls only", async () => {
    const r = await runDocusignPreflight(now);
    expect(r.ok).toBe(true);
    expect(r.environment).toBe("sandbox");
    expect(keys(r)).toEqual(["switch:ok", "credentials:ok", "key:ok", "token:ok", "template:ok", "role:ok"]);
    expect(m.json.mock.calls.map((c) => c[0])).toEqual(["templates/tpl-1", "templates/tpl-1/recipients"]);
    expect(r.checkedAt).toBe("2026-11-17T12:00:00.000Z");
    const text = JSON.stringify(r);
    expect(text).not.toContain("SECRET");
    expect(text).toContain("Rental Agreement");
  });

  it("switch off: reported, the rest still checked (credentials can be tested before the flip)", async () => {
    m.cap = { enabled: false, missing: [], ok: false };
    const r = await runDocusignPreflight(now);
    expect(r.ok).toBe(false);
    expect(keys(r)).toEqual(["switch:no", "credentials:ok", "key:ok", "token:ok", "template:ok", "role:ok"]);
  });

  it("credentials missing: named, and DocuSign is not called", async () => {
    m.cap = { enabled: true, missing: ["DOCUSIGN_TEMPLATE_ID", "DOCUSIGN_USER_ID"], ok: false };
    const r = await runDocusignPreflight(now);
    expect(keys(r)).toEqual(["switch:ok", "credentials:no"]);
    expect(r.steps[1].detail).toBe("Missing: DOCUSIGN_TEMPLATE_ID, DOCUSIGN_USER_ID.");
    expect(m.config).not.toHaveBeenCalled();
    expect(m.token).not.toHaveBeenCalled();
  });

  it("unreadable key: stops before signing in", async () => {
    m.config.mockImplementation(() => {
      throw new Error("DOCUSIGN_PRIVATE_KEY_B64 does not contain a PRIVATE KEY block");
    });
    const r = await runDocusignPreflight(now);
    expect(keys(r)).toEqual(["switch:ok", "credentials:ok", "key:no"]);
    expect(m.token).not.toHaveBeenCalled();
  });

  it("consent not granted: the error code and what to do; no template call", async () => {
    m.token.mockRejectedValue(Object.assign(new Error("DocuSign token request failed (400): consent_required"), { code: "consent_required" }));
    const r = await runDocusignPreflight(now);
    expect(keys(r)).toEqual(["switch:ok", "credentials:ok", "key:ok", "token:no"]);
    expect(r.steps[3].detail).toContain("consent_required");
    expect(r.steps[3].detail).toContain("grant consent");
    expect(m.json).not.toHaveBeenCalled();
  });

  it("template not found: stops before the role", async () => {
    m.json.mockRejectedValueOnce(Object.assign(new Error("DocuSign API 404 TEMPLATE_ID_INVALID: x"), { errorCode: "TEMPLATE_ID_INVALID" }));
    const r = await runDocusignPreflight(now);
    expect(keys(r)).toEqual(["switch:ok", "credentials:ok", "key:ok", "token:ok", "template:no"]);
    expect(r.steps[4].detail).toContain("TEMPLATE_ID_INVALID");
    expect(m.json).toHaveBeenCalledTimes(1);
  });

  it.each([
    [[{ roleName: "renter" }], "renter"],
    [[{ roleName: "Customer" }, { roleName: "Larry" }], "Customer, Larry"],
    [[], "none"],
  ])("role must be exactly Renter: %j fails", async (signers, listed) => {
    m.json.mockImplementation(async (p: string) => (p.endsWith("/recipients") ? { signers } : { name: "T" }));
    const r = await runDocusignPreflight(now);
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)).toMatchObject({ key: "role", ok: false });
    expect(r.steps.at(-1)!.detail).toContain(listed);
  });
});
