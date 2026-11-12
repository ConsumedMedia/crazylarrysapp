/**
 * Hostile values in every customer- or staff-supplied field of every
 * notification template, checked on all four outputs (SMS, subject, text,
 * HTML). Pure rendering: no network, no database.
 *
 * Which outputs a field reaches is found by rendering a marker, so a field
 * that starts appearing somewhere new is checked there automatically. Every
 * exported template must have a fixture, and fixtures are typed against the
 * template's own parameter, so a new field fails `npm run verify` until it
 * is listed here.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type * as Templates from "./templates";

let T: typeof Templates;
const savedYard = process.env.CL_YARD_PHONE;
beforeAll(async () => {
  process.env.CL_YARD_PHONE = "(614) 555-0142";
  vi.resetModules();
  T = await import("./templates");
});
afterAll(() => {
  if (savedYard === undefined) delete process.env.CL_YARD_PHONE;
  else process.env.CL_YARD_PHONE = savedYard;
});

type Kind = "one" | "multi" | "url";
type Fixture<P> = { base: P; fields: Partial<Record<keyof P & string, Kind>>; render: (p: P) => Templates.Rendered };
const fx = <P,>(f: Fixture<P>) => f as unknown as Fixture<Record<string, unknown>>;

const booking: Templates.BookingCtx = {
  contactName: "Pat Smith",
  size: "20yd",
  deliveryDate: "2026-11-12",
  pickupDate: "2026-11-19",
  address: "1 Test St, Columbus, OH 43004",
  total: 401.05,
  paid: false,
};
const bookingFields = { contactName: "one", address: "one" } as const;
const PAY = "https://app.crazylarrysdumpsters.com/pay/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";

const FIXTURES: Record<string, Fixture<Record<string, unknown>>> = {
  bookingConfirmation: fx<Parameters<typeof Templates.bookingConfirmation>[0]>({
    base: booking,
    fields: bookingFields,
    render: (p) => T.bookingConfirmation(p),
  }),
  deliveryReminder: fx<Parameters<typeof Templates.deliveryReminder>[0]>({
    base: booking,
    fields: bookingFields,
    render: (p) => T.deliveryReminder(p),
  }),
  pickupReminder: fx<Parameters<typeof Templates.pickupReminder>[0]>({
    base: booking,
    fields: bookingFields,
    render: (p) => T.pickupReminder(p),
  }),
  overdueNotice: fx<Parameters<typeof Templates.overdueNotice>[0]>({
    base: booking,
    fields: bookingFields,
    render: (p) => T.overdueNotice(p),
  }),
  deliveryComplete: fx<Parameters<typeof Templates.deliveryComplete>[0]>({
    base: { contactName: "Pat Smith", size: "20yd", address: "1 Test St, Columbus, OH 43004", pickupDate: "2026-11-19" },
    fields: bookingFields,
    render: (p) => T.deliveryComplete(p),
  }),
  pickupComplete: fx<Parameters<typeof Templates.pickupComplete>[0]>({
    base: { contactName: "Pat Smith", size: "20yd", address: "1 Test St, Columbus, OH 43004" },
    fields: bookingFields,
    render: (p) => T.pickupComplete(p),
  }),
  jobAssigned: fx<Parameters<typeof Templates.jobAssigned>[0]>({
    base: {
      driverName: "Marcus Lee",
      jobType: "delivery",
      size: "20yd",
      address: "1 Test St, Columbus, OH 43004",
      scheduledDate: "2026-11-12",
      placementNotes: "By the garage",
    },
    fields: { driverName: "one", address: "one", placementNotes: "multi" },
    render: (p) => T.jobAssigned(p),
  }),
  payLink: fx<Parameters<typeof Templates.payLink>[0]>({
    base: { ...booking, url: PAY },
    fields: { ...bookingFields, url: "url" },
    render: (p) => T.payLink(p),
  }),
  payLinkReminder: fx<Parameters<typeof Templates.payLinkReminder>[0]>({
    base: { ...booking, url: PAY },
    fields: { ...bookingFields, url: "url" },
    render: (p) => T.payLinkReminder(p),
  }),
  staffUnpaidAlert: fx<Parameters<typeof Templates.staffUnpaidAlert>[0]>({
    base: {
      contactName: "Pat Smith",
      phone: "614-555-0200",
      size: "20yd",
      deliveryDate: "2026-11-12",
      total: 401.05,
      daysUnpaid: 3,
      remindersSent: 1,
      bookingUrl: "https://app.crazylarrysdumpsters.com/bookings/00000000-0000-0000-0000-0000000000b2",
      reason: "after_days",
    },
    fields: { contactName: "one", phone: "one", bookingUrl: "url" },
    render: (p) => T.staffUnpaidAlert(p),
  }),
};

type Row = {
  name: string;
  value: string;
  /** Expected in HTML / in SMS, subject and text, for a one-line field. */
  html: string;
  text: string;
  /** Same for a multi-line field (placement notes), when different. */
  htmlMulti?: string;
  textMulti?: string;
  /** Must never appear in the HTML. */
  forbid?: string[];
};

const ROWS: Row[] = [
  { name: "script tag", value: "<script>alert(1)</script>", html: "&lt;script&gt;alert(1)&lt;/script&gt;", text: "<script>alert(1)</script>", forbid: ["<script"] },
  {
    name: "attribute breakout",
    value: `"><img src=x onerror=alert(1)>`,
    html: "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;",
    text: `"><img src=x onerror=alert(1)>`,
    forbid: ["<img"],
  },
  { name: "apostrophe and ampersand", value: "O'Brien & Sons", html: "O&#39;Brien &amp; Sons", text: "O'Brien & Sons" },
  { name: "already escaped", value: "&lt;b&gt;", html: "&amp;lt;b&amp;gt;", text: "&lt;b&gt;", forbid: ["<b>"] },
  {
    name: "CR LF fake line",
    value: "Pat\r\nPaid: $0.00",
    html: "Pat Paid: $0.00",
    text: "Pat Paid: $0.00",
    htmlMulti: "Pat<br>Paid: $0.00",
    textMulti: "Pat\nPaid: $0.00",
  },
  { name: "NUL BEL ESC DEL CSI", value: "Pat\u0000\u0007\u001b[31m\u007F\u009B", html: "Pat[31m", text: "Pat[31m" },
  { name: "bidi override and isolates", value: "\u202Eevil\u2066x\u2069\u061C", html: "evilx", text: "evilx" },
  {
    name: "line and paragraph separators, NEL",
    value: "a\u2028b\u2029c\u0085d",
    html: "a b c d",
    text: "a b c d",
    htmlMulti: "a<br>b<br>c<br>d",
    textMulti: "a\nb\nc\nd",
  },
  { name: "accents, emoji, braces", value: "José 🚚 {{x}} ${x}", html: "José 🚚 {{x}} ${x}", text: "José 🚚 {{x}} ${x}" },
  { name: "5,000 characters", value: "x".repeat(5000), html: "x".repeat(5000), text: "x".repeat(5000) },
  {
    name: "multi-line notes with markup",
    value: "a\r\nb\n\nc <i>",
    html: "a b  c &lt;i&gt;",
    text: "a b  c <i>",
    htmlMulti: "a<br>b<br><br>c &lt;i&gt;",
    textMulti: "a\nb\n\nc <i>",
    forbid: ["<i>"],
  },
  { name: "empty", value: "", html: "", text: "" },
];

// Never in any output: C0 except LF, DEL, C1, bidi controls. CR never anywhere.
const REMOVED = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u202A-\u202E\u2066-\u2069\u2028\u2029]/;
const MARK = "zqmarkq";

function reach(f: Fixture<Record<string, unknown>>, field: string) {
  const r = f.render({ ...f.base, [field]: MARK });
  return {
    sms: r.sms.includes(MARK),
    subject: r.email.subject.includes(MARK),
    text: r.email.text.includes(MARK),
    html: r.email.html.includes(MARK),
  };
}

describe("every exported template has a hostile-value fixture", () => {
  it("no template is missing", () => {
    const exported = Object.entries(T)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      .sort();
    expect(exported).toEqual(Object.keys(FIXTURES).sort());
  });

  it("every listed field reaches at least one output", () => {
    for (const [name, f] of Object.entries(FIXTURES)) {
      for (const field of Object.keys(f.fields)) {
        const r = reach(f, field);
        expect([name, field, r.sms || r.subject || r.text || r.html]).toEqual([name, field, true]);
      }
    }
  });
});

for (const [name, f] of Object.entries(FIXTURES)) {
  describe(`${name}: hostile values`, () => {
    for (const [field, kind] of Object.entries(f.fields) as Array<[string, Kind]>) {
      it.each(ROWS)(`${field}: $name`, (row) => {
        const where = reach(f, field);
        const r = f.render({ ...f.base, [field]: row.value });
        const multi = kind === "multi";
        const wantHtml = multi ? (row.htmlMulti ?? row.html) : row.html;
        const wantText = multi ? (row.textMulti ?? row.text) : row.text;

        // Control and bidi characters never survive, anywhere.
        for (const out of [r.sms, r.email.subject, r.email.text, r.email.html]) expect(out).not.toMatch(REMOVED);
        expect(r.email.subject).not.toMatch(/[\r\n]/);

        if (where.html) expect(r.email.html).toContain(wantHtml);
        for (const bad of row.forbid ?? []) expect(r.email.html).not.toContain(bad);
        if (where.sms) expect(r.sms).toContain(wantText);
        if (where.subject) expect(r.email.subject).toContain(row.text);
        if (where.text) expect(r.email.text).toContain(wantText);

        // A line break in a one-line field can't start a line of its own.
        if (!multi) {
          for (const out of [r.sms, r.email.text]) {
            for (const line of out.split("\n")) expect(line.startsWith("Paid: $0.00")).toBe(false);
          }
        }
      });
    }
  });
}

describe("URLs in buttons", () => {
  const urlFixtures = Object.entries(FIXTURES).flatMap(([name, f]) =>
    Object.entries(f.fields)
      .filter(([, k]) => k === "url")
      .map(([field]) => ({ name, f, field })),
  );

  it("there are three link buttons", () => expect(urlFixtures.map((u) => u.name)).toEqual(["payLink", "payLinkReminder", "staffUnpaidAlert"]));

  it.each(urlFixtures)("$name: an ordinary https URL becomes the href, unchanged", ({ f, field }) => {
    const url = f.base[field] as string;
    expect(f.render(f.base).email.html).toContain(`<a href="${url}"`);
  });

  it.each(urlFixtures)("$name: javascript:, data:, relative and quote-breaking URLs get no link", ({ f, field }) => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>x</script>", "/pay/abc", `https://x.test/"><script>x</script>`]) {
      const html = f.render({ ...f.base, [field]: bad }).email.html;
      expect(html).not.toContain("<a href");
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("<script");
    }
  });
});

describe("the pay-link token alphabet is URL-safe as it stands", () => {
  it("base64url needs no encoding in a path", () => {
    const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
    expect(encodeURIComponent(token)).toBe(token);
  });
});
