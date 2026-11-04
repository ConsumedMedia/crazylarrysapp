/**
 * Resend action: the booking id is the only thing in the revalidated path,
 * nothing redirects, and errors reach the screen scrubbed of tokens.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
const ID = "9ed0e892-fb0c-4620-8802-06233f6b3007";
let behaviour: () => Promise<unknown>;
const revalidatePath = vi.fn();
const redirect = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u) }));
vi.mock("@/lib/auth/requireStaff", () => ({ NotAuthorizedError: class NotAuthorizedError extends Error {} }));
vi.mock("@/lib/pay-links/staff", async () => {
  const { PayLinkError } = await vi.importActual<typeof import("@/lib/pay-links/staff")>("@/lib/pay-links/staff");
  return { PayLinkError, resendPayLink: () => behaviour() };
});

const form = (id = ID) => {
  const fd = new FormData();
  fd.set("id", id);
  return fd;
};

beforeEach(() => {
  revalidatePath.mockClear();
  redirect.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("resendPayLinkAction", () => {
  it("nothing sent: the link comes back in state only; revalidates the booking path; no redirect", async () => {
    behaviour = async () => ({ sent: [], url: `https://x.test/pay/${TOKEN}` });
    const { resendPayLinkAction } = await import("./pay-link-actions");
    const s = await resendPayLinkAction({ ok: false }, form());
    expect(s).toEqual({ ok: true, sent: [], url: `https://x.test/pay/${TOKEN}` });
    expect(revalidatePath.mock.calls).toEqual([[`/bookings/${ID}`]]);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("a PayLinkError carrying a token is shown scrubbed", async () => {
    const { PayLinkError } = await import("@/lib/pay-links/staff");
    behaviour = async () => {
      throw new PayLinkError(`refused /pay/${TOKEN}`, "x");
    };
    const { resendPayLinkAction } = await import("./pay-link-actions");
    const s = await resendPayLinkAction({ ok: false }, form());
    expect(s.error).toBe("refused /pay/…");
  });

  it("unknown error: generic message; scrubbed server log", async () => {
    behaviour = async () => {
      throw new Error(`oops ${TOKEN}`);
    };
    const { resendPayLinkAction } = await import("./pay-link-actions");
    const s = await resendPayLinkAction({ ok: false }, form());
    expect(s.error).toMatch(/Reload the booking/);
    expect(JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls)).not.toContain(TOKEN);
  });

  it("a malformed id is refused before anything runs", async () => {
    behaviour = async () => {
      throw new Error("should not run");
    };
    const { resendPayLinkAction } = await import("./pay-link-actions");
    expect((await resendPayLinkAction({ ok: false }, form("../x"))).error).toBe("Unknown booking.");
  });
});
