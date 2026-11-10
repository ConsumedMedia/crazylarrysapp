/**
 * Unit test for the daily transcript purge job. No database: the RPC is a fake.
 */
import { describe, it, expect } from "vitest";
import { runTranscriptPurge, type PurgeRpc } from "./purge";
import { TRANSCRIPT_RETENTION_DAYS } from "./config";

const ON = { CL_CALL_TRANSCRIPT_PURGE_ENABLED: "1" };

function fakeRpc(reply: Awaited<ReturnType<PurgeRpc>> | Error) {
  const calls: Array<[string, unknown]> = [];
  const rpc: PurgeRpc = async (name, args) => {
    calls.push([name, args]);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { rpc, calls };
}

describe("runTranscriptPurge", () => {
  it("flag off (unset, or anything but '1'): ok, nothing called", async () => {
    for (const env of [{}, { CL_CALL_TRANSCRIPT_PURGE_ENABLED: "true" }, { CL_CALL_TRANSCRIPT_PURGE_ENABLED: "0" }]) {
      const f = fakeRpc({ data: 9, error: null });
      expect(await runTranscriptPurge(f.rpc, env)).toEqual({
        ok: true,
        enabled: false,
        retention_days: TRANSCRIPT_RETENTION_DAYS,
        purged: 0,
      });
      expect(f.calls).toEqual([]);
    }
  });

  it("flag on: calls the RPC once with the single retention value and reports the count", async () => {
    const f = fakeRpc({ data: 3, error: null });
    expect(await runTranscriptPurge(f.rpc, ON)).toEqual({ ok: true, enabled: true, retention_days: 180, purged: 3 });
    expect(f.calls).toEqual([["purge_call_transcripts", { p_days: TRANSCRIPT_RETENTION_DAYS }]]);
  });

  it("database error: ok:false with the code only, never the message", async () => {
    const f = fakeRpc({ data: null, error: { code: "42883", message: "function does not exist: secret detail" } });
    const r = await runTranscriptPurge(f.rpc, ON);
    expect(r).toMatchObject({ ok: false, enabled: true, purged: 0, error: "purge_failed 42883" });
    expect(JSON.stringify(r)).not.toContain("secret detail");
  });

  it("the client throwing: ok:false, does not throw", async () => {
    const f = fakeRpc(new Error("fetch failed: secret"));
    const r = await runTranscriptPurge(f.rpc, ON);
    expect(r).toMatchObject({ ok: false, error: "purge_failed network" });
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("a result that isn't a non-negative integer: ok:false", async () => {
    for (const data of [null, -1, 2.5, "x"]) {
      expect((await runTranscriptPurge(fakeRpc({ data, error: null }).rpc, ON)).ok).toBe(false);
    }
  });
});
