/**
 * The Users page shows a protected account to itself only. These run the real
 * page and the real row components; the database rule is proved separately by
 * scripts/probe-protected-visibility.mjs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formHooksMock } from "@/test/form-hooks";
import type { StaffUser } from "@/lib/users/team";

vi.mock("react-dom", async (orig) => formHooksMock(await orig<object>()));
vi.mock("./actions", () => ({
  editUserAction: vi.fn(),
  removeUserAction: vi.fn(),
  restoreUserAction: vi.fn(),
  resendInviteAction: vi.fn(),
  revokeInviteAction: vi.fn(),
}));

const PROTECTED = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
let me = PROTECTED;
let users: StaffUser[] = [];
vi.mock("@/lib/auth/requireStaff", () => ({
  requireOwner: async () => ({ userId: me, role: "owner", email: "me@crazylarrys.test", fullName: null }),
}));
vi.mock("@/lib/users/team", () => ({ listStaffUsers: async () => users }));
vi.mock("@/lib/drivers/manage", () => ({ listTrucks: async () => [] }));

const user = (over: Partial<StaffUser>): StaffUser => ({
  id: OTHER_OWNER,
  fullName: "Pat Owner",
  phone: null,
  role: "owner",
  email: "pat@crazylarrys.test",
  isProtected: false,
  status: "active",
  lastSignInAt: null,
  invitedAt: null,
  driverId: null,
  driverActive: false,
  vehicleInfo: null,
  truckId: null,
  truckNickname: null,
  ...over,
});
const guarded = user({ id: PROTECTED, fullName: null, email: "guarded@crazylarrys.test", isProtected: true });

async function render() {
  const { default: Page } = await import("./page");
  return renderToStaticMarkup(await Page());
}

beforeEach(() => {
  users = [guarded, user({})];
});

describe("/users: the protected account", () => {
  it("the account itself sees its Protected section", async () => {
    me = PROTECTED;
    const html = await render();
    expect(html).toContain(">Protected<");
    expect(html).toContain("guarded@crazylarrys.test");
  });

  it("another owner sees no section, name or email, even if the database still returns the row", async () => {
    me = OTHER_OWNER;
    const html = await render();
    expect(html).not.toContain(">Protected<");
    expect(html).not.toContain("guarded@crazylarrys.test");
    expect(html).not.toContain("Protected account");
  });

  it("the row doesn't drop into Team instead, and Team's count leaves it out", async () => {
    me = OTHER_OWNER;
    const html = await render();
    expect(html).toContain("Team (1)");
    expect(html).toContain("pat@crazylarrys.test");
  });

  it("another owner with no protected row returned sees the same page", async () => {
    me = OTHER_OWNER;
    const withRow = await render();
    users = [user({})];
    expect(await render()).toBe(withRow);
  });
});
