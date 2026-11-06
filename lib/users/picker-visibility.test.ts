/**
 * The two "pick an existing account" lists leave out a protected account unless
 * it's the viewer's own: /users/new (listAllProfiles) and /drivers Add driver
 * (listCandidateProfiles).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase } from "@/test/fake-supabase";

const ME = "me";
const client = { current: null as unknown };
vi.mock("@/lib/supabase/server", () => ({ createClient: () => client.current }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({}) }));
vi.mock("@/lib/auth/requireStaff", () => ({
  assertOwner: async () => ({ userId: ME, role: "owner" }),
  assertStaff: async () => ({ userId: ME, role: "staff" }),
}));

import { listAllProfiles } from "./manage";
import { listCandidateProfiles } from "@/lib/drivers/manage";

const profiles = [
  { id: ME, full_name: "Me", role: "owner", is_protected: true },
  { id: "guarded", full_name: "Guarded", role: "owner", is_protected: true },
  { id: "plain", full_name: "Plain", role: "customer", is_protected: false },
  { id: "has-driver", full_name: "Has Driver", role: "driver", is_protected: false },
];

beforeEach(() => {
  client.current = fakeSupabase({ profiles, drivers: [{ profile_id: "has-driver" }] }).client;
});

describe("/users/new existing-account picker", () => {
  it("leaves out someone else's protected account and keeps the viewer's own", async () => {
    expect((await listAllProfiles()).map((p) => p.id)).toEqual([ME, "plain", "has-driver"].sort((a, z) => label(a).localeCompare(label(z))));
  });

  it("returns only id, name and role", async () => {
    const [first] = await listAllProfiles();
    expect(Object.keys(first).sort()).toEqual(["full_name", "id", "role"]);
  });
});

describe("/drivers Add driver picker", () => {
  it("leaves out someone else's protected account and anyone already a driver", async () => {
    expect((await listCandidateProfiles()).map((p) => p.id).sort()).toEqual([ME, "plain"].sort());
  });
});

function label(id: string): string {
  return profiles.find((p) => p.id === id)!.full_name;
}
