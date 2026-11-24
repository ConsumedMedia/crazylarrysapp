/**
 * Unit test: the DocuSign return URL's origin comes from the request host
 * only when that host is on the allowlist (NEXT_PUBLIC_SITE_URL's host,
 * VERCEL_URL, VERCEL_BRANCH_URL; localhost only outside production), https
 * except localhost, else NEXT_PUBLIC_SITE_URL as before. next/headers is a fake.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ values: {} as Record<string, string>, throws: false }));
vi.mock("next/headers", () => ({
  headers: () => {
    if (h.throws) throw new Error("headers() was called outside a request scope");
    return { get: (k: string) => h.values[k.toLowerCase()] ?? null };
  },
}));

import { fallbackReturnOrigin, requestReturnOrigin, resolveReturnOrigin } from "./return-origin";

const PROD = "https://app.crazylarrysdumpsters.com";
const ENV = {
  NEXT_PUBLIC_SITE_URL: PROD,
  VERCEL_URL: "crazylarrysapp-abc123-team.vercel.app",
  VERCEL_BRANCH_URL: "crazylarrysapp-git-docusign-port-team.vercel.app",
  NODE_ENV: "production",
};

describe("resolveReturnOrigin", () => {
  describe("allowed hosts", () => {
    it("production's own domain", () => {
      expect(resolveReturnOrigin("app.crazylarrysdumpsters.com", ENV)).toBe(PROD);
    });
    it("this deployment's VERCEL_URL", () => {
      expect(resolveReturnOrigin("crazylarrysapp-abc123-team.vercel.app", ENV)).toBe("https://crazylarrysapp-abc123-team.vercel.app");
    });
    it("this branch's VERCEL_BRANCH_URL (the Preview case that broke)", () => {
      expect(resolveReturnOrigin("crazylarrysapp-git-docusign-port-team.vercel.app", ENV)).toBe(
        "https://crazylarrysapp-git-docusign-port-team.vercel.app",
      );
    });
    // A non-production host here, so a mishandled header would show as the
    // production fallback rather than pass by coincidence.
    it("case and surrounding space don't matter", () => {
      expect(resolveReturnOrigin("  CrazyLarrysApp-ABC123-team.vercel.app ", ENV)).toBe("https://crazylarrysapp-abc123-team.vercel.app");
    });
    it("a proxy list uses its first host only", () => {
      expect(resolveReturnOrigin("crazylarrysapp-abc123-team.vercel.app, evil.example", ENV)).toBe("https://crazylarrysapp-abc123-team.vercel.app");
      expect(resolveReturnOrigin("evil.example, crazylarrysapp-abc123-team.vercel.app", ENV)).toBe(PROD);
    });
    it("Vercel values given with a scheme or trailing slash still match", () => {
      const env = { ...ENV, VERCEL_URL: "https://crazylarrysapp-abc123-team.vercel.app/" };
      expect(resolveReturnOrigin("crazylarrysapp-abc123-team.vercel.app", env)).toBe("https://crazylarrysapp-abc123-team.vercel.app");
    });
  });

  describe("https only, except localhost", () => {
    it("an http NEXT_PUBLIC_SITE_URL still yields https for its host", () => {
      expect(resolveReturnOrigin("app.crazylarrysdumpsters.com", { ...ENV, NEXT_PUBLIC_SITE_URL: "http://app.crazylarrysdumpsters.com" })).toBe(PROD);
    });
    it("localhost outside production is http, port kept", () => {
      const dev = { ...ENV, NODE_ENV: "development" };
      expect(resolveReturnOrigin("localhost:3000", dev)).toBe("http://localhost:3000");
      expect(resolveReturnOrigin("127.0.0.1:3001", dev)).toBe("http://127.0.0.1:3001");
      expect(resolveReturnOrigin("[::1]:3000", dev)).toBe("http://[::1]:3000");
    });
  });

  describe("spoofed or unknown hosts fall back to NEXT_PUBLIC_SITE_URL", () => {
    it.each([
      "evil.example",
      "app.crazylarrysdumpsters.com.evil.example",
      "evil-app.crazylarrysdumpsters.com",
      "crazylarrysapp-other-team.vercel.app",
      "app.crazylarrysdumpsters.com:8443",
      "app.crazylarrysdumpsters.com/evil",
      "app.crazylarrysdumpsters.com@evil.example",
      "user:pass@app.crazylarrysdumpsters.com",
      "app.crazylarrysdumpsters.com\r\nX: y",
      "https://app.crazylarrysdumpsters.com",
    ])("%s", (host) => {
      expect(resolveReturnOrigin(host, ENV)).toBe(PROD);
    });
    it("an unset Vercel variable allows nothing extra", () => {
      const env = { NEXT_PUBLIC_SITE_URL: PROD, NODE_ENV: "production" };
      expect(resolveReturnOrigin("crazylarrysapp-abc123-team.vercel.app", env)).toBe(PROD);
      expect(resolveReturnOrigin("", env)).toBe(PROD);
    });
  });

  describe("localhost in production", () => {
    it.each(["localhost", "localhost:3000", "127.0.0.1:3000", "[::1]:3000"])("%s is refused", (host) => {
      expect(resolveReturnOrigin(host, ENV)).toBe(PROD);
    });
    it("even when NEXT_PUBLIC_SITE_URL itself is localhost (local next start): only the fallback, as before", () => {
      const env = { NEXT_PUBLIC_SITE_URL: "http://localhost:3000", NODE_ENV: "production" };
      expect(resolveReturnOrigin("localhost:3000", env)).toBe("http://localhost:3000");
      expect(resolveReturnOrigin("localhost:4000", env)).toBe("http://localhost:3000");
    });
  });

  describe("missing header", () => {
    it.each([null, undefined, "", "   "])("%j -> NEXT_PUBLIC_SITE_URL", (host) => {
      expect(resolveReturnOrigin(host, ENV)).toBe(PROD);
    });
    it("and with no NEXT_PUBLIC_SITE_URL either: the old local default", () => {
      expect(resolveReturnOrigin(null, { NODE_ENV: "production" })).toBe("http://localhost:3000");
      expect(fallbackReturnOrigin({})).toBe("http://localhost:3000");
    });
    it("the fallback drops trailing slashes, as before", () => {
      expect(fallbackReturnOrigin({ NEXT_PUBLIC_SITE_URL: `${PROD}//` })).toBe(PROD);
    });
  });
});

describe("requestReturnOrigin (the request's headers)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    h.values = {};
    h.throws = false;
    Object.assign(process.env, ENV);
  });
  afterEach(() => {
    for (const k of Object.keys(ENV)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("allowed host", () => {
    h.values = { host: "crazylarrysapp-git-docusign-port-team.vercel.app" };
    expect(requestReturnOrigin()).toBe("https://crazylarrysapp-git-docusign-port-team.vercel.app");
  });
  it("x-forwarded-host wins over host (Next's own order)", () => {
    h.values = { "x-forwarded-host": "crazylarrysapp-abc123-team.vercel.app", host: "app.crazylarrysdumpsters.com" };
    expect(requestReturnOrigin()).toBe("https://crazylarrysapp-abc123-team.vercel.app");
  });
  it("spoofed host -> NEXT_PUBLIC_SITE_URL", () => {
    h.values = { "x-forwarded-host": "evil.example", host: "app.crazylarrysdumpsters.com" };
    expect(requestReturnOrigin()).toBe(PROD);
  });
  it("localhost in production -> NEXT_PUBLIC_SITE_URL", () => {
    h.values = { host: "localhost:3000" };
    expect(requestReturnOrigin()).toBe(PROD);
  });
  it("missing header -> NEXT_PUBLIC_SITE_URL", () => {
    expect(requestReturnOrigin()).toBe(PROD);
  });
  it("outside a request (headers() throws) -> NEXT_PUBLIC_SITE_URL", () => {
    h.throws = true;
    expect(requestReturnOrigin()).toBe(PROD);
  });
});
