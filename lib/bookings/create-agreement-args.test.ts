/**
 * Unit test — create_booking's arguments in each mode. Attest (no opts): the
 * RPC gets exactly users-page's arguments, with no p_agreement_session_id key.
 * DocuSign: the session id, or null. Supabase is a fake.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ rpc: (fn: string, a: unknown) => m.rpc(fn, a) }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));

import { createBooking, normalizeBookingInput } from "./create";
import { yardTomorrow } from "@/lib/time/yard";
import type { CreateBookingInput } from "./types";

const params = () =>
  normalizeBookingInput({
    size: "20yd",
    deliveryDate: yardTomorrow(),
    street: "1 Test St",
    city: "Columbus",
    state: "OH",
    zip: "43215",
    contactName: "Args Test",
    contactEmail: "args@crazylarrys.test",
  } as CreateBookingInput);

beforeEach(() => {
  m.rpc.mockReset().mockResolvedValue({ data: "bk-1", error: null });
});

describe("create_booking arguments", () => {
  it("attest (no opts): users-page's arguments, no session key at all", async () => {
    const p = params();
    await createBooking(p);
    const [fn, args] = m.rpc.mock.calls[0];
    expect(fn).toBe("create_booking");
    expect(args).toEqual({ ...p, p_profile_id: null });
    expect(Object.keys(args)).not.toContain("p_agreement_session_id");
  });
  it("docusign: the session id", async () => {
    await createBooking(params(), { agreementSessionId: "agr-1" });
    expect(m.rpc.mock.calls[0][1]).toMatchObject({ p_agreement_session_id: "agr-1" });
  });
  it("docusign with no session: null (the database refuses nothing; the gate already did)", async () => {
    await createBooking(params(), { agreementSessionId: null });
    expect(m.rpc.mock.calls[0][1]).toHaveProperty("p_agreement_session_id", null);
  });
});
