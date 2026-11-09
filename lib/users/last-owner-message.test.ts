/**
 * When the database refuses to lose the last counted owner, the owner sees the
 * database's own words, which say what to do: add another owner first. The
 * text is read from the migration, so a wording change there shows up here.
 * The rule itself is proved by scripts/probe-last-owner.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const SQL = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20261109000000_last_counted_owner.sql"), "utf8");
const MESSAGE = SQL.match(/raise exception '([^']*)'\s+using errcode = '42501', hint = 'last_owner'/)![1];
const REFUSAL = { code: "42501", hint: "last_owner", message: MESSAGE, details: null };

const ME = "11111111-1111-4111-8111-111111111111";
const ban = vi.fn(async () => ({ error: null }));
const writes: string[] = [];

function profileQuery() {
  const row = { id: ME, role: "owner", full_name: "Pat Owner", phone: null, is_protected: false, removed_at: null, drivers: [] };
  const b = {
    select: () => b,
    eq: () => b,
    maybeSingle: async () => ({ data: row, error: null }),
    update: (v: unknown) => {
      writes.push(JSON.stringify(v));
      const u = { eq: () => u, select: async () => ({ data: null, error: REFUSAL }) };
      return u;
    },
  };
  return b;
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: () => profileQuery(),
    rpc: async (name: string) => (writes.push(name), { data: null, error: REFUSAL }),
  }),
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ auth: { admin: { updateUserById: ban } } }) }));
vi.mock("@/lib/auth/requireStaff", () => ({ assertOwner: async () => ({ userId: ME, role: "owner", email: "pat@crazylarrys.test" }) }));
vi.mock("@/lib/drivers/manage", () => ({ createDriver: vi.fn(), updateDriver: vi.fn() }));

import { editUser, removeUser } from "./team";

beforeEach(() => {
  ban.mockClear();
  writes.length = 0;
});

describe("last counted owner: what the owner is told", () => {
  it("the migration's message says to add another owner first", () => {
    expect(MESSAGE).toContain("Add another owner first");
  });

  it("demoting: the edit fails with that message", async () => {
    await expect(
      editUser({ profileId: ME, fullName: "Pat Owner", phone: null, access: "staff", driver: false, truckId: null, vehicleInfo: null }),
    ).rejects.toThrow(`Role change failed: ${MESSAGE}`);
    expect(writes).toEqual([JSON.stringify({ role: "staff" })]);
  });

  it("removing (here, yourself): fails with that message, and the login is not banned", async () => {
    await expect(removeUser(ME, "pat@crazylarrys.test")).rejects.toThrow(MESSAGE);
    expect(writes).toEqual(["remove_staff_user"]);
    expect(ban).not.toHaveBeenCalled();
  });
});
