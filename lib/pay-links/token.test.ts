import { describe, it, expect, afterEach } from "vitest";
import { isPayToken, payLinkUrl, redactPayLinks, clientKeyFor, clientIpFrom } from "./token";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"; // 43 chars

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

describe("pay-link tokens", () => {
  it("accepts exactly 43 base64url characters", () => {
    expect(TOKEN).toHaveLength(43);
    expect(isPayToken(TOKEN)).toBe(true);
    expect(isPayToken(TOKEN.slice(1))).toBe(false);
    expect(isPayToken(`${TOKEN}A`)).toBe(false);
    expect(isPayToken(TOKEN.replace("_", "/"))).toBe(false);
    expect(isPayToken(null)).toBe(false);
  });

  it("builds the URL from NEXT_PUBLIC_SITE_URL (no double slash), production by default", () => {
    expect(payLinkUrl(TOKEN)).toBe(`https://app.crazylarrysdumpsters.com/pay/${TOKEN}`);
    process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000/";
    expect(payLinkUrl(TOKEN)).toBe(`http://localhost:3000/pay/${TOKEN}`);
  });

  it("redacts every token in a string, and only tokens", () => {
    const s = `Pay here: https://x/pay/${TOKEN} or http://y/pay/${TOKEN}. Booking /bookings/123`;
    const r = redactPayLinks(s);
    expect(r).not.toContain(TOKEN);
    expect(r).toBe("Pay here: https://x/pay/… or http://y/pay/…. Booking /bookings/123");
    expect(redactPayLinks(null)).toBeNull();
  });

  it("rate-limit key is a stable HMAC, never the IP itself", () => {
    const a = clientKeyFor("203.0.113.7");
    expect(a).toBe(clientKeyFor(" 203.0.113.7 "));
    expect(a).not.toContain("203.0.113.7");
    expect(a).not.toBe(clientKeyFor("203.0.113.8"));
    expect(clientKeyFor(null)).toBe(clientKeyFor(""));
  });

  it("takes the first x-forwarded-for address, else x-real-ip", () => {
    const h = (m: Record<string, string>) => ({ get: (k: string) => m[k] ?? null });
    expect(clientIpFrom(h({ "x-forwarded-for": "198.51.100.1, 10.0.0.1", "x-real-ip": "10.0.0.2" }))).toBe("198.51.100.1");
    expect(clientIpFrom(h({ "x-real-ip": "10.0.0.2" }))).toBe("10.0.0.2");
    expect(clientIpFrom(h({}))).toBeNull();
  });
});
