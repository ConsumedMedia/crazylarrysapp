/**
 * Unit test — /book's server actions decide the agreement mode themselves on
 * every request (docusign-port, task 4). Attest: users-page's action
 * unchanged. DocuSign: the session goes to payAndBook's gate. A page loaded
 * under the other mode is refused before anything is touched, and no
 * envelope is ever started in attest mode. Mode, checkout and DocuSign are fakes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  mode: "attest" as "attest" | "docusign",
  payAndBook: vi.fn(),
  start: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("@/lib/bookings/checkout", () => ({ payAndBook: (...a: unknown[]) => m.payAndBook(...a) }));
vi.mock("@/lib/docusign/agreement", () => ({
  startAgreementSession: (...a: unknown[]) => m.start(...a),
  verifyAgreementSession: (...a: unknown[]) => m.verify(...a),
}));
const req = vi.hoisted(() => ({ headers: {} as Record<string, string> }));
vi.mock("next/headers", () => ({ headers: () => ({ get: (k: string) => req.headers[k.toLowerCase()] ?? null }) }));
vi.mock("@/lib/docusign/mode", async () => ({
  ...(await vi.importActual<typeof import("@/lib/docusign/mode-shared")>("@/lib/docusign/mode-shared")),
  effectiveAgreementMode: async () => m.mode,
}));

import { payAndBookAction, startAgreementAction, verifyAgreementAction } from "./actions";
import { MODE_CHANGED } from "@/lib/docusign/mode-shared";
import type { CreateBookingInput } from "@/lib/bookings/types";

const booking = {
  size: "20yd",
  deliveryDate: "2026-12-01",
  street: "1 Test St",
  city: "Columbus",
  state: "OH",
  zip: "43215",
  contactName: "Action Test",
  contactEmail: "action@crazylarrys.test",
} as CreateBookingInput;
const pay = { paymentToken: "tok", idempotencyKey: "idem" };

// Production as on Vercel (Preview included): NODE_ENV production, the site
// URL is production's domain, this deployment's branch URL is set.
const PROD = "https://app.crazylarrysdumpsters.com";
const BRANCH = "crazylarrysapp-git-docusign-port-team.vercel.app";
afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  req.headers = {};
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", PROD);
  vi.stubEnv("VERCEL_BRANCH_URL", BRANCH);
  vi.stubEnv("VERCEL_URL", undefined);
  m.payAndBook.mockReset().mockResolvedValue({ ok: true, bookingId: "bk" });
  m.start.mockReset().mockResolvedValue({ ok: true, sessionId: "s1", signingUrl: "https://x" });
  m.verify.mockReset().mockResolvedValue({ ok: true, signerEmail: "a@b.c" });
});

describe("attest mode: users-page's action", () => {
  beforeEach(() => {
    m.mode = "attest";
  });
  it("checkbox not ticked: users-page's refusal, nothing charged", async () => {
    const r = await payAndBookAction({ ...booking, ...pay, agreementAcknowledged: false });
    expect(r).toEqual({ ok: false, error: "Please open and complete the rental agreement first.", code: "agreement" });
    expect(m.payAndBook).not.toHaveBeenCalled();
  });
  it("ticked: payAndBook gets the booking without the flag, and attest", async () => {
    await payAndBookAction({ ...booking, ...pay, agreementAcknowledged: true });
    expect(m.payAndBook).toHaveBeenCalledWith(booking, { token: "tok", idempotencyKey: "idem" }, { mode: "attest" });
  });
  it("ticked but no token: no_token, after the checkbox (users-page's order)", async () => {
    expect(await payAndBookAction({ ...booking, paymentToken: "", idempotencyKey: "idem", agreementAcknowledged: true })).toMatchObject({ code: "no_token" });
    expect(await payAndBookAction({ ...booking, paymentToken: "", idempotencyKey: "idem", agreementAcknowledged: false })).toMatchObject({ code: "agreement" });
  });
  it("a DocuSign page (session, no checkbox): mode changed, nothing charged", async () => {
    const r = await payAndBookAction({ ...booking, ...pay, agreementSessionId: "s1" });
    expect(r).toEqual({ ok: false, ...MODE_CHANGED });
    expect(m.payAndBook).not.toHaveBeenCalled();
  });
  it("no envelope is started or checked", async () => {
    expect(await startAgreementAction({ contactName: "A", contactEmail: "a@b.c", existingSessionId: null })).toEqual({ ok: false, ...MODE_CHANGED });
    expect(await verifyAgreementAction("s1")).toMatchObject({ ok: false, code: MODE_CHANGED.code });
    expect(m.start).not.toHaveBeenCalled();
    expect(m.verify).not.toHaveBeenCalled();
  });
});

describe("docusign mode", () => {
  beforeEach(() => {
    m.mode = "docusign";
  });
  it("the session goes to payAndBook's gate", async () => {
    await payAndBookAction({ ...booking, ...pay, agreementSessionId: "s1" });
    expect(m.payAndBook).toHaveBeenCalledWith(booking, { token: "tok", idempotencyKey: "idem" }, { mode: "docusign", sessionId: "s1" });
  });
  it("a null session still goes to the gate (which refuses it)", async () => {
    await payAndBookAction({ ...booking, ...pay, agreementSessionId: null });
    expect(m.payAndBook).toHaveBeenCalledWith(booking, expect.anything(), { mode: "docusign", sessionId: null });
  });
  it("an attest page (ticked checkbox, no session): mode changed, never booked on a checkbox", async () => {
    const r = await payAndBookAction({ ...booking, ...pay, agreementAcknowledged: true });
    expect(r).toEqual({ ok: false, ...MODE_CHANGED });
    expect(m.payAndBook).not.toHaveBeenCalled();
  });
  it("both fields sent: still the gate decides (the checkbox counts for nothing)", async () => {
    await payAndBookAction({ ...booking, ...pay, agreementAcknowledged: true, agreementSessionId: null });
    expect(m.payAndBook).toHaveBeenCalledWith(booking, expect.anything(), { mode: "docusign", sessionId: null });
  });
  it("starting and verifying reach DocuSign", async () => {
    await startAgreementAction({ contactName: "A", contactEmail: "a@b.c", existingSessionId: null });
    await verifyAgreementAction("s1");
    expect(m.start).toHaveBeenCalledWith({ signerName: "A", signerEmail: "a@b.c", existingSessionId: null, returnOrigin: PROD });
    expect(m.verify).toHaveBeenCalledWith("s1");
  });
});

describe("docusign mode: the return URL's origin is this request's allowlisted host", () => {
  beforeEach(() => {
    m.mode = "docusign";
  });
  const start = () => startAgreementAction({ contactName: "A", contactEmail: "a@b.c", existingSessionId: null });

  it("allowed host (the Preview branch URL): returns there, not to production", async () => {
    req.headers = { host: BRANCH };
    await start();
    expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ returnOrigin: `https://${BRANCH}` }));
  });
  it("spoofed host: NEXT_PUBLIC_SITE_URL", async () => {
    req.headers = { "x-forwarded-host": "evil.example", host: BRANCH };
    await start();
    expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ returnOrigin: PROD }));
  });
  it("localhost in production: NEXT_PUBLIC_SITE_URL", async () => {
    req.headers = { host: "localhost:3000" };
    await start();
    expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ returnOrigin: PROD }));
  });
  it("missing header: NEXT_PUBLIC_SITE_URL", async () => {
    await start();
    expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ returnOrigin: PROD }));
  });
  it("attest mode never reads it or starts anything", async () => {
    m.mode = "attest";
    req.headers = { host: BRANCH };
    await start();
    expect(m.start).not.toHaveBeenCalled();
  });
});
