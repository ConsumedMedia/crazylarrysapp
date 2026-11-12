/**
 * Escaping for notification templates (SMS, email subject, email text, email
 * HTML). Escape-by-default: a template builds every string with one of two
 * tags, and every interpolated value is cleaned by the tag, so no field has
 * to be judged "safe" by hand.
 *
 *   html`…`  every value: control/bidi characters removed, line breaks folded
 *            to a space, then & < > " ' escaped. Values that are already
 *            SafeHtml (made only by this module) pass through untouched.
 *            Returns SafeHtml.
 *   text`…`  for SMS, subjects and plain-text email: every value has control
 *            and bidi characters removed and line breaks folded to a space.
 *            Nothing is HTML-escaped (it isn't HTML). Returns a string.
 *   multiline(v)  marks a value whose line breaks are meant (placement
 *            notes): text keeps them as \n, html joins escaped lines with <br>.
 *   href(url)     an absolute http(s) URL, escaped for an attribute, or null.
 *
 * Ordinary values (letters, digits, spaces, punctuation other than & < > " ')
 * come out byte for byte as they went in. Nothing is trimmed or truncated.
 */

const KEY = Symbol("SafeHtml");

/** HTML that is safe to place in an email body. Only this module makes one. */
export class SafeHtml {
  readonly value: string;
  constructor(key: symbol, value: string) {
    if (key !== KEY) throw new Error("SafeHtml is made only by the html tag");
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

/** A value whose line breaks are kept (see multiline()). */
export class Multiline {
  constructor(readonly value: string) {}
}

export function multiline(value: string): Multiline {
  return new Multiline(value);
}

// Removed outright: C0 controls except tab/LF/VT/FF/CR (folded below), DEL,
// C1 controls except NEL (folded below), and the bidi embedding, override and
// isolate characters plus the Arabic letter mark, which can reorder what the
// reader sees.
const REMOVE = /[\u0000-\u0008\u000E-\u001F\u007F\u0080-\u0084\u0086-\u009F\u061C\u202A-\u202E\u2066-\u2069]/g;
// Each becomes one space in a one-line value. CR LF counts as one break.
const BREAKS = /\r\n|[\t\n\u000B\u000C\r\u0085\u2028\u2029]/g;
// In a multi-line value, every kind of line break becomes \n; tab/VT/FF a space.
const LINE_BREAKS = /\r\n|[\r\u0085\u2028\u2029]/g;
const SPACES = /[\t\u000B\u000C]/g;

/** One line: control/bidi characters removed, line breaks folded to a space. */
export function oneLine(value: string): string {
  return value.replace(REMOVE, "").replace(BREAKS, " ");
}

/** Line breaks kept as \n; control/bidi characters removed. */
export function multiLineText(value: string): string {
  return value.replace(REMOVE, "").replace(LINE_BREAKS, "\n").replace(SPACES, " ");
}

/** & < > " ' escaped, the same five characters the pay-link templates used. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type HtmlValue = string | number | SafeHtml | Multiline;
type TextValue = string | number | Multiline;

function htmlOf(v: HtmlValue): string {
  if (v instanceof SafeHtml) return v.value;
  if (v instanceof Multiline) return multiLineText(v.value).split("\n").map(escapeHtml).join("<br>");
  if (typeof v === "number") return escapeHtml(String(v));
  if (typeof v === "string") return escapeHtml(oneLine(v));
  throw new TypeError("html: unsupported value");
}

function textOf(v: TextValue): string {
  if (v instanceof Multiline) return multiLineText(v.value);
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return oneLine(v);
  throw new TypeError("text: unsupported value");
}

/** HTML template tag: every interpolated value is cleaned and escaped. */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += htmlOf(values[i]) + strings[i + 1];
  return new SafeHtml(KEY, out);
}

/** Plain-text template tag (SMS, subjects, text email): values cleaned, not escaped. */
export function text(strings: TemplateStringsArray, ...values: TextValue[]): string {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += textOf(values[i]) + strings[i + 1];
  return out;
}

/** Joins SafeHtml parts into one SafeHtml. */
export function joinHtml(parts: SafeHtml[], separator = ""): SafeHtml {
  return new SafeHtml(KEY, parts.map((p) => p.value).join(escapeHtml(separator)));
}

const HTTP_URL = /^https?:\/\/[^\s\u0000-\u001F\u007F-\u009F"'<>\\`]+$/i;

/**
 * An absolute http(s) URL, escaped for an href attribute, or null for anything
 * else (javascript:, data:, relative, spaces, control characters). The string
 * is kept as given, not re-serialized, so a valid URL comes out unchanged.
 */
export function href(url: string): SafeHtml | null {
  if (!HTTP_URL.test(url)) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return new SafeHtml(KEY, escapeHtml(url));
}
