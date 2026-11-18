/**
 * Unit test — saving the owner's agreement mode: owner session only, only the
 * mode column of cl_agreement_settings, RLS's "0 rows" read as not an owner, and the
 * migration-not-applied error said plainly. Supabase is a fake.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  owner: true,
  update: vi.fn(),
  result: { data: [{ mode: "docusign" }], error: null } as { data: unknown; error: { code?: string } | null },
}));
vi.mock("@/lib/auth/requireStaff", () => ({
  assertOwner: async () => {
    if (!m.owner) throw new Error("Only owners can do that.");
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (t: string) => ({
      update: (v: unknown) => {
        m.update(t, v);
        return { eq: (c: string, val: unknown) => ({ select: async () => (m.update(c, val), m.result) }) };
      },
    }),
  }),
}));

import { parseAgreementModeForm, saveAgreementMode } from "./mode-settings";

const fd = (v?: string) => {
  const f = new FormData();
  if (v !== undefined) f.set("agreement_mode", v);
  return f;
};

beforeEach(() => {
  m.owner = true;
  m.update.mockReset();
  m.result = { data: [{ mode: "docusign" }], error: null };
});

describe("parseAgreementModeForm", () => {
  it.each(["attest", "docusign"])("%s ok", (v) => expect(parseAgreementModeForm(fd(v))).toEqual({ ok: true, value: v }));
  it.each([undefined, "", "DocuSign", "on", "attest "])("%j refused", (v) => expect(parseAgreementModeForm(fd(v)).ok).toBe(false));
});

describe("saveAgreementMode", () => {
  it("updates only mode on the singleton row", async () => {
    await saveAgreementMode("docusign");
    expect(m.update.mock.calls).toEqual([["cl_agreement_settings", { mode: "docusign" }], ["id", true]]);
  });
  it("not an owner: refused before the database", async () => {
    m.owner = false;
    await expect(saveAgreementMode("docusign")).rejects.toThrow("Only owners");
    expect(m.update).not.toHaveBeenCalled();
  });
  it("RLS let nothing through (0 rows): not an owner", async () => {
    m.result = { data: [], error: null };
    await expect(saveAgreementMode("attest")).rejects.toThrow("Only an owner can change the rental agreement setting.");
  });
  it.each(["42P01", "PGRST205"])("table missing (%s): says the migration isn't applied", async (code) => {
    m.result = { data: null, error: { code } };
    await expect(saveAgreementMode("attest")).rejects.toThrow("migration 20261117000000");
  });
  it("a bad value never reaches the database", async () => {
    await expect(saveAgreementMode("on" as never)).rejects.toThrow("Pick");
    expect(m.update).not.toHaveBeenCalled();
  });
});
