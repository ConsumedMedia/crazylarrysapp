/**
 * Unit test: both places startAgreementSession builds a DocuSign return URL
 * (a new session, and a reused open one) use the requester's allowlisted
 * origin when given one, and NEXT_PUBLIC_SITE_URL when not. The database and
 * DocuSign are fakes; nothing is written and no envelope is created.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const SID = "8afffacf-0000-4000-8000-000000000001";
const f = vi.hoisted(() => ({
  open: [] as Record<string, unknown>[],
  signing: vi.fn(),
  created: vi.fn(),
}));

// A chainable stand-in for the supabase query builder: every filter returns
// the builder; awaiting it (or .single/.maybeSingle) resolves by query kind.
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: () => {
      let kind: "select" | "count" | "insert" | "update" = "select";
      let single = false;
      const result = () => {
        if (kind === "count") return { count: 0, error: null };
        if (kind === "insert") return { data: { id: SID }, error: null };
        if (kind === "update") return { data: null, error: null };
        return single ? { data: f.open[0] ?? null, error: null } : { data: f.open, error: null };
      };
      const b: Record<string, unknown> = {};
      for (const k of ["eq", "in", "is", "gt", "gte", "lt", "order", "limit"]) b[k] = () => b;
      b.select = (_c?: string, o?: { head?: boolean }) => {
        if (o?.head) kind = "count";
        return b;
      };
      b.insert = () => ((kind = "insert"), b);
      b.update = () => ((kind = "update"), b);
      b.single = async () => ((single = true), result());
      b.maybeSingle = async () => ((single = true), result());
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
      return b;
    },
  }),
}));
vi.mock("./config", () => ({ docusignConfigured: () => true }));
vi.mock("./envelopes", () => ({
  createAgreementEnvelope: async () => (f.created(), { envelopeId: "env-1" }),
  createSigningUrl: async (o: { returnUrl: string }) => (f.signing(o.returnUrl), "https://demo.docusign.net/signing/x"),
  // Still "sent": the reused session is not signed yet, so a signing URL is made.
  getAgreementEnvelope: async () => ({ status: "sent", signer: null, sessionField: null, completedAt: null }),
  voidAgreementEnvelope: async () => undefined,
}));

import { agreementReturnUrl, startAgreementSession } from "./agreement";

const PROD = "https://app.crazylarrysdumpsters.com";
const BRANCH = "https://crazylarrysapp-git-docusign-port-team.vercel.app";
const ret = (origin: string) => `${origin}/book/agreement/return?session=${SID}`;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", PROD);
  f.open = [];
  f.signing.mockReset();
  f.created.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agreementReturnUrl", () => {
  it("uses the origin it is given", () => {
    expect(agreementReturnUrl(SID, BRANCH)).toBe(ret(BRANCH));
    expect(agreementReturnUrl(SID, `${BRANCH}/`)).toBe(ret(BRANCH));
  });
  it("without one: NEXT_PUBLIC_SITE_URL, as before", () => {
    expect(agreementReturnUrl(SID)).toBe(ret(PROD));
  });
  it("encodes the session id", () => {
    expect(agreementReturnUrl("a&b", PROD)).toBe(`${PROD}/book/agreement/return?session=a%26b`);
  });
});

describe("startAgreementSession", () => {
  const signer = { signerName: "ZZ Return Test", signerEmail: "return@crazylarrys.test" };

  it("new session: the return URL is on the given origin", async () => {
    const r = await startAgreementSession({ ...signer, returnOrigin: BRANCH });
    expect(r).toMatchObject({ ok: true, sessionId: SID });
    expect(f.created).toHaveBeenCalledTimes(1);
    expect(f.signing).toHaveBeenCalledWith(ret(BRANCH));
  });
  it("new session without an origin: NEXT_PUBLIC_SITE_URL", async () => {
    await startAgreementSession(signer);
    expect(f.signing).toHaveBeenCalledWith(ret(PROD));
  });

  const openRow = {
    id: SID,
    envelope_id: "env-1",
    signer_name: signer.signerName,
    signer_email: signer.signerEmail,
    status: "sent",
    completed_at: null,
    verified_at: null,
    last_checked_at: null,
    check_count: 0,
    consumed_booking_id: null,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  };
  it("reused open session: the return URL is on the given origin, and no new envelope", async () => {
    f.open = [openRow];
    const r = await startAgreementSession({ ...signer, existingSessionId: SID, returnOrigin: BRANCH });
    expect(r).toMatchObject({ ok: true, sessionId: SID });
    expect(f.created).not.toHaveBeenCalled();
    expect(f.signing).toHaveBeenCalledWith(ret(BRANCH));
  });
  it("reused open session without an origin: NEXT_PUBLIC_SITE_URL", async () => {
    f.open = [openRow];
    await startAgreementSession({ ...signer, existingSessionId: SID });
    expect(f.signing).toHaveBeenCalledWith(ret(PROD));
  });
});
