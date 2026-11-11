import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formHooksMock } from "@/test/form-hooks";
import type { PayLinkSettings, AlertRecipientStatus } from "@/lib/pay-links/settings-shared";

vi.mock("react-dom", async (orig) => formHooksMock(await orig<object>()));
vi.mock("./actions", () => ({
  saveSizePricingAction: vi.fn(),
  saveGlobalSettingsAction: vi.fn(),
  savePayLinkSettingsAction: vi.fn(),
  saveBookingCutoffAction: vi.fn(),
}));
let cutoff: { cutoff_enabled: boolean; cutoff_time: string; updated_at: string | null } | null = {
  cutoff_enabled: false,
  cutoff_time: "15:00",
  updated_at: null,
};
vi.mock("@/lib/bookings/cutoff-settings", async () => ({
  ...(await import("@/lib/bookings/cutoff-settings-shared")),
  getBookingCutoffSettings: async () => cutoff,
}));
vi.mock("./_components/QuickBooksPanel", () => ({ QuickBooksPanel: () => <div data-stub="qbo" /> }));

let role: "owner" | "staff" = "owner";
vi.mock("@/lib/auth/requireStaff", () => ({ requireStaff: async () => ({ userId: "u1", role }) }));
vi.mock("@/lib/bookings/pricing", () => ({
  getPricingConfig: async () => ({
    sizes: [],
    settings: {
      extra_day_rate: 0,
      overage_ton_rate: 0,
      credit_card_fee_rate: 0,
      driveway_fee_rate: 0,
      tax_rate: 0.07,
      tax_jurisdiction: null,
      tax_verified: true,
      tax_verified_note: null,
    },
    bookingReady: true,
  }),
}));

let settings: PayLinkSettings;
let recipient: AlertRecipientStatus;
let live = { live: 0, withoutStoredLink: 0 };
const listAlertCandidates = vi.fn(async () => [
  { id: "11111111-1111-4111-8111-111111111111", name: "Larry", role: "owner" as const },
]);
vi.mock("@/lib/pay-links/settings", async () => {
  const shared = await import("@/lib/pay-links/settings-shared");
  return {
    ...shared,
    getPayLinkSettings: async () => settings,
    getLiveCounts: async () => live,
    getAlertRecipientStatus: async () => recipient,
    listAlertCandidates: () => listAlertCandidates(),
  };
});

const OFF: PayLinkSettings = {
  enabled: false,
  reminder_after_days: 2,
  reminder_repeat: false,
  reminder_max: 3,
  staff_alert_after_days: 3,
  staff_alert_user_id: null,
  staff_alert_each_reminder: false,
  updated_at: null,
};

async function render() {
  const { default: Page } = await import("./page");
  return renderToStaticMarkup(await Page({ searchParams: {} }));
}

beforeEach(() => {
  role = "owner";
  settings = OFF;
  recipient = { chosenName: null, chosenUsable: false, usingFallback: true };
  live = { live: 0, withoutStoredLink: 0 };
  listAlertCandidates.mockClear();
  delete process.env.CL_NOTIFICATIONS_TEST_TO;
  process.env.CL_NOTIFICATIONS_ENABLED = "1";
  process.env.CL_PAY_LINK_TOKEN_KEY = "k".repeat(40);
});

describe("/settings — Customer pay links", () => {
  it("owner: editable, Off badge, picker of candidates, fallback warning", async () => {
    const html = await render();
    expect(html).toContain("Customer pay links");
    expect(html).toMatch(/>Off</);
    expect(html).toContain('name="staff_alert_user_id"');
    expect(html).toContain("Larry (owner)");
    expect(html).toContain("All visible owners");
    expect(html).toContain("No alert person is chosen — unpaid-booking alerts go to all visible owners.");
    expect(html).not.toMatch(/visible owners \(\d/);
    expect(html).toContain("Save pay-link settings");
    expect(html).not.toMatch(/name="enabled"[^>]*disabled/);
    // Inputs carry the database's limits.
    expect(html).toMatch(/name="reminder_max"[^>]*min="1"[^>]*max="10"/);
  });

  it("staff: read-only, no picker, and the owner-only candidate list is never requested", async () => {
    role = "staff";
    const html = await render();
    expect(html).toContain("Read-only — only the owner can change pay-link settings.");
    expect(html).not.toContain('name="staff_alert_user_id"');
    expect(html).not.toContain("Save pay-link settings");
    expect(html).toMatch(/name="enabled"[^>]*disabled/);
    expect(listAlertCandidates).not.toHaveBeenCalled();
  });

  it("shows live links while OFF, and that they stay payable", async () => {
    live = { live: 2, withoutStoredLink: 1 };
    const html = await render();
    expect(html).toContain("2 links are live");
    expect(html).toContain("1 can&#x27;t go in a reminder until staff press Resend");
    expect(html).toContain("they stay payable while pay links are off");
  });

  it("chosen person removed -> fallback warning names them; usable -> no warning", async () => {
    settings = { ...OFF, staff_alert_user_id: "22222222-2222-4222-8222-222222222222" };
    recipient = { chosenName: "Alice", chosenUsable: false, usingFallback: true };
    expect(await render()).toContain("Alice is removed, hidden or no longer staff — unpaid-booking alerts go to all visible owners.");
    recipient = { chosenName: "Alice", chosenUsable: true, usingFallback: false };
    expect(await render()).not.toContain("unpaid-booking alerts go to all visible owners");
  });

  describe("a chosen person this owner can't see", () => {
    const UNSEEN = "33333333-3333-4333-8333-333333333333";
    const unseen = () => {
      settings = { ...OFF, staff_alert_user_id: UNSEEN };
      recipient = { chosenName: null, chosenUsable: true, usingFallback: false };
    };

    it("owner: the choice stays selected as Current recipient, with no name and no warning", async () => {
      unseen();
      const html = await render();
      expect(html).toMatch(new RegExp(`<option value="${UNSEEN}" selected="">Current recipient</option>`));
      expect(html).not.toContain("alerts go to all visible owners");
    });

    it("staff: reads Current recipient, not a blank", async () => {
      unseen();
      role = "staff";
      const html = await render();
      expect(html).toContain(">Current recipient<");
      expect(html).not.toContain(UNSEEN);
    });

    it("no extra option when the chosen person is in the picker", async () => {
      settings = { ...OFF, staff_alert_user_id: "11111111-1111-4111-8111-111111111111" };
      recipient = { chosenName: "Larry", chosenUsable: true, usingFallback: false };
      const html = await render();
      expect(html).not.toContain("Current recipient");
      expect(html).toMatch(/selected="">Larry \(owner\)/);
    });

    it("no extra option when the chosen person is no longer usable: the fallback warning shows instead", async () => {
      settings = { ...OFF, staff_alert_user_id: UNSEEN };
      recipient = { chosenName: "Alice", chosenUsable: false, usingFallback: true };
      const html = await render();
      expect(html).not.toContain("Current recipient");
      expect(html).toContain("Alice is removed, hidden or no longer staff");
    });
  });

  it("environment warnings: token key, test redirect, notifications off", async () => {
    delete process.env.CL_PAY_LINK_TOKEN_KEY;
    process.env.CL_NOTIFICATIONS_TEST_TO = "me@crazylarrys.test";
    process.env.CL_NOTIFICATIONS_ENABLED = "0";
    const html = await render();
    expect(html).toContain("CL_PAY_LINK_TOKEN_KEY isn&#x27;t set on this server");
    expect(html).toContain("CL_NOTIFICATIONS_TEST_TO is set");
    expect(html).toContain("CL_NOTIFICATIONS_ENABLED isn&#x27;t 1");
    expect(html).not.toContain("me@crazylarrys.test");
  });

  it("no environment warnings when all is set", async () => {
    const html = await render();
    expect(html).not.toContain("CL_PAY_LINK_TOKEN_KEY");
    expect(html).not.toContain("CL_NOTIFICATIONS_");
  });

  it("On badge when enabled", async () => {
    settings = { ...OFF, enabled: true };
    expect(await render()).toMatch(/>On</);
  });
});

describe("/settings — Order cutoff", () => {
  const panel = (html: string) => html.slice(html.indexOf('data-testid="booking-cutoff-panel"'));
  beforeEach(() => {
    cutoff = { cutoff_enabled: false, cutoff_time: "15:00", updated_at: null };
  });

  it("owner: the panel with the on/off box and the time picker, off by default", async () => {
    const p = panel(await render());
    expect(p).toContain("Order cutoff");
    expect(p).toMatch(/>Off</);
    expect(p).toContain('name="cutoff_enabled"');
    expect(p).toContain('name="cutoff_time"');
    expect(p).toContain("Save order cutoff");
  });

  it("staff: read-only, no inputs", async () => {
    role = "staff";
    cutoff = { cutoff_enabled: true, cutoff_time: "15:00", updated_at: null };
    const p = panel(await render());
    expect(p).not.toContain('name="cutoff_time"');
    expect(p).not.toContain("Save order cutoff");
    expect(p).toContain("On — online and pay-link orders after 3:00 PM Eastern deliver from the day after tomorrow.");
    expect(p).toContain("only an owner can change it");
  });

  it("unreadable: says so and that bookings follow the usual rule; no form", async () => {
    cutoff = null;
    const p = panel(await render());
    expect(p).toContain("couldn&#x27;t be read just now");
    expect(p).not.toContain('name="cutoff_time"');
  });
});
