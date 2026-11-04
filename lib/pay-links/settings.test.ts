import { describe, it, expect, vi, beforeEach } from "vitest";
import { envWarnings, parsePayLinkSettingsForm, PAY_LINK_LIMITS } from "./settings-shared";

// ---- the session client the library uses (staff/owner's own session) ----
type Result = { data: unknown; error: unknown; count?: number };
const calls: Array<{ table?: string; rpc?: string; op: string; arg?: unknown }> = [];
let results: Record<string, Result> = {};

function builder(table: string) {
  const b: Record<string, unknown> = {};
  const chain = (op: string) => (arg?: unknown) => {
    calls.push({ table, op, arg });
    return b;
  };
  for (const op of ["select", "eq", "is", "update", "maybeSingle"]) b[op] = chain(op);
  // Awaiting the builder resolves the result for this table (+ op variant).
  b.then = (res: (v: Result) => unknown) => {
    const key = calls.filter((c) => c.table === table).some((c) => c.op === "update") ? `${table}:update` : table;
    return Promise.resolve(results[key] ?? { data: null, error: null }).then(res);
  };
  return b;
}
const client = {
  from: (t: string) => builder(t),
  rpc: (name: string, args?: unknown) => {
    calls.push({ rpc: name, op: "rpc", arg: args });
    return Promise.resolve(results[`rpc:${name}`] ?? { data: null, error: null });
  },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: () => client }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => {
    throw new Error("service_role must not be used for pay-link settings");
  },
}));
let role: "owner" | "staff" = "owner";
vi.mock("@/lib/auth/requireStaff", () => ({
  assertStaff: async () => ({ userId: "u-owner", role, email: null, fullName: null }),
  assertOwner: async () => {
    if (role !== "owner") throw new Error("Owner access required");
    return { userId: "u-owner", role, email: null, fullName: null };
  },
}));

import {
  getAlertRecipientStatus,
  getLiveCounts,
  getPayLinkSettings,
  savePayLinkSettings,
} from "./settings";

const ALICE = "11111111-1111-4111-8111-111111111111";
const form = (o: Record<string, string>) => ({ get: (k: string) => (k in o ? o[k] : null) });
const good = { reminder_after_days: "2", reminder_max: "3", staff_alert_after_days: "3" };

beforeEach(() => {
  calls.length = 0;
  results = {};
  role = "owner";
});

describe("parsePayLinkSettingsForm — the database's limits", () => {
  it("accepts the defaults and reads the checkboxes", () => {
    const r = parsePayLinkSettingsForm(form({ ...good, enabled: "on", reminder_repeat: "on" }));
    expect(r).toEqual({
      ok: true,
      value: {
        enabled: true,
        reminder_after_days: 2,
        reminder_repeat: true,
        reminder_max: 3,
        staff_alert_after_days: 3,
        staff_alert_user_id: null,
        staff_alert_each_reminder: false,
      },
    });
  });

  for (const [key, [lo, hi]] of Object.entries(PAY_LINK_LIMITS)) {
    it(`${key}: ${lo} and ${hi} pass, ${lo - 1}, ${hi + 1}, 1.5 and blank fail`, () => {
      expect(parsePayLinkSettingsForm(form({ ...good, [key]: String(lo) })).ok).toBe(true);
      expect(parsePayLinkSettingsForm(form({ ...good, [key]: String(hi) })).ok).toBe(true);
      for (const bad of [String(lo - 1), String(hi + 1), "1.5", "", "-1", "2e1"]) {
        expect(parsePayLinkSettingsForm(form({ ...good, [key]: bad })).ok, `${key}=${bad}`).toBe(false);
      }
    });
  }

  it("refuses a malformed alert user id", () => {
    expect(parsePayLinkSettingsForm(form({ ...good, staff_alert_user_id: "nobody" })).ok).toBe(false);
    expect(parsePayLinkSettingsForm(form({ ...good, staff_alert_user_id: ALICE })).ok).toBe(true);
  });
});

describe("envWarnings", () => {
  it("all three, and none", () => {
    expect(envWarnings({ NODE_ENV: "test" })).toEqual(["token_key_missing", "notifications_disabled"]);
    expect(envWarnings({ NODE_ENV: "test", CL_NOTIFICATIONS_TEST_TO: "me@x.test", CL_NOTIFICATIONS_ENABLED: "0" })).toEqual([
      "token_key_missing",
      "test_redirect_on",
      "notifications_disabled",
    ]);
    expect(
      envWarnings({ NODE_ENV: "test", CL_PAY_LINK_TOKEN_KEY: "k".repeat(32), CL_NOTIFICATIONS_ENABLED: "1" }),
    ).toEqual([]);
  });
  it("a key shorter than 32 characters counts as missing (same rule as payLinkTokenKey)", () => {
    expect(envWarnings({ NODE_ENV: "test", CL_PAY_LINK_TOKEN_KEY: "short", CL_NOTIFICATIONS_ENABLED: "1" })).toEqual([
      "token_key_missing",
    ]);
  });
  it("never returns the values themselves", () => {
    const out = JSON.stringify(
      envWarnings({ NODE_ENV: "test", CL_NOTIFICATIONS_TEST_TO: "secret-me@x.test", CL_PAY_LINK_TOKEN_KEY: "s" }),
    );
    expect(out).not.toContain("secret-me");
  });
});

describe("reads on the staff session", () => {
  it("getPayLinkSettings names its columns and treats a missing row as off", async () => {
    results.cl_pay_link_settings = { data: null, error: null };
    const s = await getPayLinkSettings();
    expect(s.enabled).toBe(false);
    const sel = calls.find((c) => c.table === "cl_pay_link_settings" && c.op === "select");
    expect(sel?.arg).not.toContain("*");
    expect(String(sel?.arg)).toContain("enabled");
  });

  it("getLiveCounts reads pay_link_live_counts (works while off)", async () => {
    results["rpc:pay_link_live_counts"] = { data: [{ live: 2, without_stored_link: 1 }], error: null };
    expect(await getLiveCounts()).toEqual({ live: 2, withoutStoredLink: 1 });
  });

  it("alert recipient: no one chosen -> fallback to visible owners", async () => {
    results.profiles = { data: null, error: null, count: 3 };
    expect(await getAlertRecipientStatus(null)).toEqual({
      chosenName: null,
      chosenUsable: false,
      usingFallback: true,
      visibleOwners: 3,
    });
  });

  it("alert recipient: chosen but removed -> fallback; active -> no fallback", async () => {
    results.profiles = {
      data: { full_name: "Alice", role: "staff", removed_at: "2026-11-01T00:00:00Z", hidden_from_users: false },
      error: null,
      count: 3,
    };
    expect((await getAlertRecipientStatus(ALICE)).usingFallback).toBe(true);
    results.profiles = {
      data: { full_name: "Alice", role: "staff", removed_at: null, hidden_from_users: false },
      error: null,
      count: 3,
    };
    const ok = await getAlertRecipientStatus(ALICE);
    expect(ok.usingFallback).toBe(false);
    expect(ok.chosenName).toBe("Alice");
  });
});

describe("savePayLinkSettings (owner session)", () => {
  const value = {
    enabled: true,
    reminder_after_days: 2,
    reminder_repeat: false,
    reminder_max: 3,
    staff_alert_after_days: 3,
    staff_alert_user_id: null,
    staff_alert_each_reminder: false,
  };

  it("staff (not owner) is refused before any write", async () => {
    role = "staff";
    await expect(savePayLinkSettings(value)).rejects.toThrow(/Owner/);
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });

  it("writes the fields plus updated_by = the owner", async () => {
    results["cl_pay_link_settings:update"] = { data: [{ enabled: true }], error: null };
    await savePayLinkSettings(value);
    const upd = calls.find((c) => c.op === "update");
    expect(upd?.arg).toEqual({ ...value, updated_by: "u-owner" });
  });

  it("an RLS-refused update (zero rows) is an error, not silent success", async () => {
    results["cl_pay_link_settings:update"] = { data: [], error: null };
    await expect(savePayLinkSettings(value)).rejects.toThrow(/Only the owner/);
  });

  it("an alert user outside the picker is refused before any write", async () => {
    results["rpc:list_staff_users"] = { data: [], error: null };
    await expect(savePayLinkSettings({ ...value, staff_alert_user_id: ALICE })).rejects.toThrow(/active staff or owner/);
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });

  it("the database's bad_alert_user refusal reads in plain words", async () => {
    results["rpc:list_staff_users"] = { data: [{ id: ALICE, role: "staff", full_name: "Alice" }], error: null };
    results["cl_pay_link_settings:update"] = { data: null, error: { code: "23514", hint: "bad_alert_user", message: "x" } };
    await expect(savePayLinkSettings({ ...value, staff_alert_user_id: ALICE })).rejects.toThrow(/active staff or owner/);
  });

  it("out-of-range numbers are refused even if the form parser were bypassed", async () => {
    await expect(savePayLinkSettings({ ...value, reminder_max: 11 })).rejects.toThrow(/reminder_max/);
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });
});
