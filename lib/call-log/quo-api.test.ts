/**
 * Unit test for the read-only Quo REST client. No network: fetch, clock,
 * sleep and randomness are all fakes, so these tests make no request to Quo.
 */
import { describe, it, expect } from "vitest";
import { createQuoClient, QuoApiError, QUO_API_VERSION, type QuoClientOptions } from "./quo-api";

const KEY = "quo_test_key_" + "x".repeat(20);

type Reply = { status: number; body?: unknown; throws?: Error; badJson?: boolean };

function harness(replies: Reply[], over: Partial<QuoClientOptions> = {}) {
  let clock = 1_000_000;
  const slept: number[] = [];
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const queue = [...replies];
  const client = createQuoClient({
    key: KEY,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    random: () => 0.5,
    fetch: async (url, init) => {
      seen.push({ url, headers: init.headers });
      const r = queue.shift();
      if (!r) throw new Error("no more replies");
      if (r.throws) throw r.throws;
      return {
        status: r.status,
        json: async () => {
          if (r.badJson) throw new SyntaxError("Unexpected token");
          return r.body;
        },
      };
    },
    ...over,
  });
  return { client, slept, seen, advance: (ms: number) => (clock += ms) };
}

const page = (data: unknown[], nextCursor: string | null = null) => ({ status: 200, body: { data, nextCursor } });

async function failure(p: Promise<unknown>): Promise<QuoApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(QuoApiError);
    return e as QuoApiError;
  }
  throw new Error("expected a QuoApiError");
}

describe("Quo client — requests", () => {
  it("sends the raw key (no Bearer) and the pinned API version; bracketed query names survive", async () => {
    const h = harness([page([{ id: "AC1" }], "cur2")]);
    const r = await h.client.getPage("/calls", {
      phoneNumberId: "PNXYakN6nP",
      "createdAt[gte]": "2026-11-07T00:00:00.000Z",
      after: undefined,
      limit: "50",
    });
    expect(r).toEqual({ data: [{ id: "AC1" }], nextCursor: "cur2" });
    expect(h.seen[0].headers).toEqual({ Authorization: KEY, "Quo-Api-Version": QUO_API_VERSION });
    const u = new URL(h.seen[0].url);
    expect(u.origin + u.pathname).toBe("https://api.quo.com/calls");
    expect(u.searchParams.get("createdAt[gte]")).toBe("2026-11-07T00:00:00.000Z");
    expect(u.searchParams.has("after")).toBe(false);
  });

  it("an empty or missing nextCursor means the last page", async () => {
    const h = harness([{ status: 200, body: { data: [], nextCursor: "" } }, { status: 200, body: { data: [] } }]);
    expect((await h.client.getPage("/calls")).nextCursor).toBeNull();
    expect((await h.client.getPage("/calls")).nextCursor).toBeNull();
  });

  it("spaces requests at least 200 ms apart (5 a second, half of Quo's per-key limit)", async () => {
    const h = harness([page([]), page([]), page([])]);
    await h.client.getPage("/calls");
    await h.client.getPage("/calls");
    h.advance(500);
    await h.client.getPage("/calls");
    expect(h.slept).toEqual([200]);
  });
});

describe("Quo client — every failure is a typed QuoApiError", () => {
  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not_found"],
    [400, "http"],
  ] as const)("HTTP %i -> %s, not retried", async (status, kind) => {
    const h = harness([{ status }]);
    const e = await failure(h.client.getPage("/calls"));
    expect(e.kind).toBe(kind);
    expect(e.status).toBe(status);
    expect(h.client.requests).toBe(1);
  });

  it("429 is retried with backoff, then reported as rate_limited", async () => {
    const h = harness([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
    const e = await failure(h.client.getPage("/calls"));
    expect(e.kind).toBe("rate_limited");
    expect(h.client.requests).toBe(4);
    // 500, 1000, 2000 ms plus jitter (0.5 * 250); request spacing sleeps never fire here.
    expect(h.slept).toEqual([625, 1125, 2125]);
  });

  it("a 429 followed by success returns the page", async () => {
    const h = harness([{ status: 429 }, page([{ id: "AC9" }])]);
    expect((await h.client.getPage("/calls")).data).toEqual([{ id: "AC9" }]);
  });

  it("5xx is retried, then reported as http with its status", async () => {
    const h = harness([{ status: 502 }, { status: 503 }, { status: 500 }, { status: 500 }]);
    const e = await failure(h.client.getPage("/calls"));
    expect([e.kind, e.status]).toEqual(["http", 500]);
  });

  it("fetch throwing -> network; an abort -> timeout", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect((await failure(harness([{ status: 0, throws: new TypeError("fetch failed") }]).client.getPage("/calls"))).kind).toBe(
      "network",
    );
    expect((await failure(harness([{ status: 0, throws: abort }]).client.getPage("/calls"))).kind).toBe("timeout");
  });

  it("2xx that isn't JSON, or has no data array -> bad_response", async () => {
    expect((await failure(harness([{ status: 200, badJson: true }]).client.getPage("/calls"))).kind).toBe("bad_response");
    expect((await failure(harness([{ status: 200, body: { calls: [] } }]).client.getPage("/calls"))).kind).toBe(
      "bad_response",
    );
    expect((await failure(harness([{ status: 200, body: null }]).client.getPage("/calls"))).kind).toBe("bad_response");
  });

  it("the request cap stops the client before it sends, retries included", async () => {
    const h = harness([{ status: 429 }, { status: 429 }, page([])], { maxRequests: 2 });
    const e = await failure(h.client.getPage("/calls"));
    expect(e.kind).toBe("request_cap");
    expect(h.client.requests).toBe(2);
  });

  it("error messages carry kind, status and path only: no key, query string or body", async () => {
    const h = harness([{ status: 401, body: { message: "secret detail 4111 1111 1111 1111" } }]);
    const e = await failure(h.client.getPage("/calls/AC1/transcripts", { after: "cursor-xyz" }));
    expect(e.message).toBe("Quo API unauthorized (401) on /calls/AC1/transcripts");
    expect(e.message).not.toContain(KEY);
    expect(e.message).not.toContain("cursor-xyz");
  });
});
