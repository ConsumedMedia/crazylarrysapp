import { createHmac } from "node:crypto";

/**
 * Pay-link token helpers. Pure apart from reading env. The token itself is
 * made by the database (issue_pay_link / staff_create_pay_link_booking) and
 * only its SHA-256 is stored; the text exists in the message we send and in
 * the customer's URL, nowhere else.
 */

/** 32 random bytes as base64url without padding. */
export const PAY_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function isPayToken(s: string | null | undefined): s is string {
  return typeof s === "string" && PAY_TOKEN.test(s);
}

export function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? "https://app.crazylarrysdumpsters.com").replace(/\/+$/, "");
}

export function payLinkUrl(token: string): string {
  return `${siteUrl()}/pay/${token}`;
}

/**
 * Replace every pay-link token in a string with "…", so a log row, an error
 * message or a console line never holds a working link.
 */
export function redactPayLinks(text: string): string;
export function redactPayLinks(text: string | null): string | null;
export function redactPayLinks(text: string | null): string | null {
  if (text == null) return text;
  return text.replace(/\/pay\/[A-Za-z0-9_-]{43}/g, "/pay/…");
}

/**
 * The rate-limit key for a visitor: an HMAC of their IP, so the database never
 * holds raw IPs. Keyed with the service-role key (server-only, never sent out).
 */
export function clientKeyFor(ip: string | null | undefined): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createHmac("sha256", `pay-link-rate:${secret}`)
    .update((ip ?? "").trim() || "unknown")
    .digest("base64url");
}

/** First address in x-forwarded-for, else x-real-ip (Vercel sets both). */
export function clientIpFrom(headers: { get(name: string): string | null }): string | null {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim() || null;
  return headers.get("x-real-ip");
}

/**
 * Key for the encrypted copy of a live link (pay_links.token_encrypted), so
 * reminders can resend the same link. Server env only; never stored in the
 * database. Under 32 characters counts as unset: links are then issued
 * without a stored copy and the cron reports reminders it couldn't send.
 */
export function payLinkTokenKey(): string | null {
  const k = (process.env.CL_PAY_LINK_TOKEN_KEY ?? "").trim();
  return k.length >= 32 ? k : null;
}
