/**
 * Unit test — the Settings actions for the rental agreement. "Check DocuSign"
 * is staff-only: anyone else never reaches the preflight (so never DocuSign).
 * Saving reports what /book on THIS deployment now uses. Auth, the preflight
 * and the save are fakes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  staff: true,
  preflight: vi.fn(),
  save: vi.fn(),
  cap: { enabled: false, missing: [] as string[], ok: false },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/requireStaff", () => {
  class NotAuthorizedError extends Error {}
  return {
    NotAuthorizedError,
    assertStaff: async () => {
      if (!m.staff) throw new NotAuthorizedError("Staff only.");
    },
  };
});
vi.mock("@/lib/docusign/preflight", () => ({ runDocusignPreflight: () => m.preflight() }));
vi.mock("@/lib/docusign/mode-settings", () => ({
  // The real parser is tested in lib/docusign/mode-settings.test.ts.
  parseAgreementModeForm: (fd: FormData) => {
    const v = String(fd.get("agreement_mode") ?? "");
    return v === "attest" || v === "docusign" ? { ok: true, value: v } : { ok: false, error: "Pick" };
  },
  saveAgreementMode: (v: string) => m.save(v),
}));
vi.mock("@/lib/docusign/mode", async () => ({
  ...(await vi.importActual<typeof import("@/lib/docusign/mode-shared")>("@/lib/docusign/mode-shared")),
  docusignCapability: () => m.cap,
}));
vi.mock("@/lib/bookings/pricing", () => ({ updateSizePricing: vi.fn(), updatePricingSettings: vi.fn() }));
vi.mock("@/lib/pay-links/settings", () => ({ parsePayLinkSettingsForm: vi.fn(), savePayLinkSettings: vi.fn() }));
vi.mock("@/lib/bookings/cutoff-settings", () => ({ parseCutoffSettingsForm: vi.fn(), saveBookingCutoffSettings: vi.fn() }));

import { checkDocusignAction, saveAgreementModeAction } from "./actions";

const fd = (v: string) => {
  const f = new FormData();
  f.set("agreement_mode", v);
  return f;
};

beforeEach(() => {
  m.staff = true;
  m.cap = { enabled: false, missing: [], ok: false };
  m.preflight.mockReset().mockResolvedValue({ ok: true, environment: "sandbox", steps: [], checkedAt: "t" });
  m.save.mockReset().mockResolvedValue(undefined);
});

describe("Check DocuSign", () => {
  it("not staff: refused, the preflight never runs", async () => {
    m.staff = false;
    expect(await checkDocusignAction()).toEqual({ ran: false, error: "Staff only." });
    expect(m.preflight).not.toHaveBeenCalled();
  });
  it("staff: runs it and returns the result", async () => {
    expect(await checkDocusignAction()).toMatchObject({ ran: true, result: { ok: true, environment: "sandbox" } });
    expect(m.preflight).toHaveBeenCalledTimes(1);
  });
  it("the check throwing: a plain error, nothing leaked", async () => {
    m.preflight.mockRejectedValue(new Error("secret detail"));
    expect(await checkDocusignAction()).toEqual({ ran: true, error: "The check itself failed. Try again." });
  });
});

describe("saving the mode", () => {
  it("attest", async () => {
    expect(await saveAgreementModeAction({ ok: false }, fd("attest"))).toEqual({ ok: true, message: "Saved: /book uses the PowerForm and checkbox." });
    expect(m.save).toHaveBeenCalledWith("attest");
  });
  it("docusign on a deployment that can: says /book uses DocuSign now", async () => {
    m.cap = { enabled: true, missing: [], ok: true };
    expect((await saveAgreementModeAction({ ok: false }, fd("docusign"))).message).toBe("Saved: /book uses DocuSign on this deployment now.");
  });
  it("docusign on a deployment that can't: says it keeps the PowerForm here, and why", async () => {
    m.cap = { enabled: false, missing: ["DOCUSIGN_USER_ID"], ok: false };
    const r = await saveAgreementModeAction({ ok: false }, fd("docusign"));
    expect(r.ok).toBe(true);
    expect(r.message).toContain("keeps the PowerForm");
    expect(r.message).toContain("CL_DOCUSIGN_ENABLED is not 1; missing DOCUSIGN_USER_ID");
    expect(r.message).toContain("Preview and Production share this setting");
  });
  it("a bad value: refused before saving", async () => {
    expect(await saveAgreementModeAction({ ok: false }, fd("on"))).toEqual({ ok: false, error: "Pick" });
    expect(m.save).not.toHaveBeenCalled();
  });
  it("the save refusing (not an owner): its message", async () => {
    m.save.mockRejectedValue(new Error("Only an owner can change the rental agreement setting."));
    expect(await saveAgreementModeAction({ ok: false }, fd("docusign"))).toEqual({ ok: false, error: "Only an owner can change the rental agreement setting." });
  });
});
