/** Unit tests for the notification escaping helper. Pure functions. */
import { describe, it, expect } from "vitest";
import { SafeHtml, escapeHtml, href, html, joinHtml, multiline, multiLineText, oneLine, text } from "./escape";

describe("html tag", () => {
  it("escapes & < > \" ' in every value and leaves the template's own markup alone", () => {
    const v = `<a href="x">O'Brien & Sons</a>`;
    expect(html`<strong>Hi</strong> ${v}`.value).toBe(
      "<strong>Hi</strong> &lt;a href=&quot;x&quot;&gt;O&#39;Brien &amp; Sons&lt;/a&gt;",
    );
  });

  it("escapes already-escaped text again (never unescapes)", () => {
    expect(html`${"&lt;b&gt;"}`.value).toBe("&amp;lt;b&amp;gt;");
  });

  it("passes SafeHtml through untouched, so nesting doesn't double-escape", () => {
    const inner = html`<em>${"a & b"}</em>`;
    expect(html`<p>${inner}</p>`.value).toBe("<p><em>a &amp; b</em></p>");
  });

  it("numbers are escaped like strings (no-op for digits)", () => {
    expect(html`${3} days`.value).toBe("3 days");
  });

  it("folds line breaks and removes control and bidi characters before escaping", () => {
    expect(html`${"a\r\nb\u0000\u202E<c>"}`.value).toBe("a b&lt;c&gt;");
  });

  it("multiline values keep line breaks as <br>, each line escaped", () => {
    expect(html`Notes: ${multiline("a\r\nb\n\nc <i>")}`.value).toBe("Notes: a<br>b<br><br>c &lt;i&gt;");
  });

  it("an ordinary value comes out byte for byte", () => {
    const v = "1 Test St, Columbus, OH 43004 — José 🚚 {{x}} ${x}";
    expect(html`${v}`.value).toBe(v);
  });

  it("an object that only looks like SafeHtml is refused", () => {
    const fake = { value: "<script>" } as unknown as SafeHtml;
    expect(() => html`${fake}`).toThrow(TypeError);
  });

  it("SafeHtml can't be made outside the module", () => {
    expect(() => new SafeHtml(Symbol("SafeHtml"), "<script>")).toThrow();
  });
});

describe("text tag", () => {
  it("doesn't HTML-escape", () => {
    expect(text`Hi ${"<b>O'Brien & Sons</b>"},`).toBe("Hi <b>O'Brien & Sons</b>,");
  });

  it("folds every kind of line break to one space (CR LF counts once)", () => {
    expect(text`${"a\r\nb\rc\nd\te\u000Bf\u000Cg\u0085h\u2028i\u2029j"}`).toBe("a b c d e f g h i j");
  });

  it("removes C0, DEL, C1 and bidi control characters", () => {
    expect(text`${"Pat\u0000\u0007\u001b[31m\u007F\u0080\u009F\u061C\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069x"}`).toBe(
      "Pat[31mx",
    );
  });

  it("keeps ordinary spaces as they are (no collapsing, no trimming)", () => {
    expect(text`${"  1  Test St  "}`).toBe("  1  Test St  ");
  });

  it("multiline values keep \\n", () => {
    expect(text`Notes: ${multiline("a\r\nb\u2028c\td")}`).toBe("Notes: a\nb\nc d");
  });

  it("is idempotent", () => {
    const once = text`${"a\r\nb\u202Ec"}`;
    expect(text`${once}`).toBe(once);
  });

  it("refuses a non-string value", () => {
    expect(() => text`${{} as unknown as string}`).toThrow(TypeError);
  });
});

describe("oneLine / multiLineText / escapeHtml", () => {
  it("oneLine", () => expect(oneLine("a\r\n\u202Eb")).toBe("a b"));
  it("multiLineText", () => expect(multiLineText("a\r\n\u202Eb\rc")).toBe("a\nb\nc"));
  it("escapeHtml", () => expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;"));
});

describe("joinHtml", () => {
  it("joins SafeHtml parts, escaping the separator", () => {
    expect(joinHtml([html`<b>a</b>`, html`${"<c>"}`], " & ").value).toBe("<b>a</b> &amp; &lt;c&gt;");
  });
});

describe("href", () => {
  it("accepts absolute http(s) URLs unchanged", () => {
    const pay = "https://app.crazylarrysdumpsters.com/pay/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
    expect(href(pay)?.value).toBe(pay);
    expect(href("http://localhost:3000/bookings/00000000-0000-0000-0000-0000000000b2")?.value).toBe(
      "http://localhost:3000/bookings/00000000-0000-0000-0000-0000000000b2",
    );
  });

  it("escapes & in a query string", () => {
    expect(href("https://x.test/a?b=1&c=2")?.value).toBe("https://x.test/a?b=1&amp;c=2");
  });

  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>",
    "/pay/abc",
    "//evil.test/x",
    "https://x.test/a b",
    "https://x.test/a\nb",
    "https://x.test/\u0000",
    'https://x.test/"onmouseover="x',
    "https://x.test/<script>",
    "ftp://x.test/a",
    "",
  ])("refuses %j", (u) => {
    expect(href(u)).toBeNull();
  });
});
