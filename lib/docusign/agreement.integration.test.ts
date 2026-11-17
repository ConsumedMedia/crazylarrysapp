/**
 * Integration test — agreement session lifecycle against the DocuSign SANDBOX
 * and the linked Supabase project.
 *
 *   CL_RUN_DOCUSIGN_TESTS=1 npx vitest run lib/docusign/agreement.integration.test.ts
 *
 * Refuses to run unless DOCUSIGN_ENVIRONMENT=sandbox. Signers are
 * @example.com embedded recipients (not emailed a signing link). Cleanup
 * voids every envelope it created and deletes every session row, each step
 * independently guarded.
 *
 * Completing a signature needs a human in DocuSign's signing page, so the
 * "completed" path is verified separately (manual step); here we cover
 * start / reuse / unsigned verification / throttle / daily void.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const RUN = process.env.CL_RUN_DOCUSIGN_TESTS === "1";
const EMAIL = `agreement-lifecycle-${Date.now()}@example.com`;

describe.skipIf(!RUN)("agreement sessions (DocuSign sandbox + DB)", () => {
  let service: SupabaseClient;
  let agreement: typeof import("./agreement");
  let envelopes: typeof import("./envelopes");
  const sessionIds: string[] = [];

  beforeAll(async () => {
    if (process.env.DOCUSIGN_ENVIRONMENT !== "sandbox") {
      throw new Error("Refusing to run: DOCUSIGN_ENVIRONMENT must be 'sandbox'.");
    }
    service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    agreement = await import("./agreement");
    envelopes = await import("./envelopes");
  });

  afterAll(async () => {
    const { data } = await service.from("agreement_sessions").select("id, envelope_id").eq("signer_email", EMAIL);
    for (const s of data ?? []) {
      if (s.envelope_id) {
        try {
          const st = await envelopes.getAgreementEnvelope(s.envelope_id as string);
          if (!["voided", "completed", "declined"].includes(st.status)) {
            await envelopes.voidAgreementEnvelope(s.envelope_id as string, "Automated test cleanup");
          }
          console.log(`[cleanup] envelope ${String(s.envelope_id).slice(0, 8)}… -> ${(await envelopes.getAgreementEnvelope(s.envelope_id as string)).status}`);
        } catch (e) {
          console.error("[cleanup] envelope", (e as Error).message);
        }
      }
      try {
        await service.from("agreement_sessions").delete().eq("id", s.id);
      } catch (e) {
        console.error("[cleanup] session", (e as Error).message);
      }
    }
  });

  it("start creates a session + sent envelope + signing URL; reopening reuses the same envelope", async () => {
    const r = await agreement.startAgreementSession({ signerName: "ZZ Lifecycle Test", signerEmail: EMAIL.toUpperCase() });
    expect(r.ok).toBe(true);
    if (!r.ok || !r.signingUrl) throw new Error("start failed");
    sessionIds.push(r.sessionId);
    const { data: row } = await service.from("agreement_sessions").select("status, signer_email, envelope_id, expires_at").eq("id", r.sessionId).single();
    const hoursToExpiry = Math.round((new Date(row!.expires_at).getTime() - Date.now()) / 3_600_000);
    console.log(`start -> session ${r.sessionId.slice(0, 8)}… status=${row!.status} email_normalized=${row!.signer_email === EMAIL} expires_in≈${hoursToExpiry}h signing host=${new URL(r.signingUrl).host}`);
    expect(row!.status).toBe("sent");
    expect(row!.signer_email).toBe(EMAIL);
    expect(hoursToExpiry).toBeGreaterThanOrEqual(47);

    const again = await agreement.startAgreementSession({ signerName: "ZZ Lifecycle Test", signerEmail: EMAIL, existingSessionId: r.sessionId });
    const { count } = await service.from("agreement_sessions").select("id", { count: "exact", head: true }).eq("signer_email", EMAIL);
    console.log(`reopen -> same session=${again.ok && again.sessionId === r.sessionId}, sessions for this email=${count}`);
    expect(again.ok && again.sessionId).toBe(r.sessionId);
    expect(count).toBe(1);
  });

  it("reopen made one recovery check; a later verify asks DocuSign once more and refuses; an immediate re-check is throttled locally", async () => {
    const id = sessionIds[0];
    const { data: before } = await service.from("agreement_sessions").select("check_count").eq("id", id).single();
    console.log(`after reopen: DocuSign checks=${before!.check_count} (the reopen verified before re-issuing a signing URL)`);
    expect(before!.check_count).toBe(1);
    // simulate the customer returning 60s later
    await service.from("agreement_sessions").update({ last_checked_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", id);
    const v1 = await agreement.verifyAgreementSession(id);
    const { data: after1 } = await service.from("agreement_sessions").select("status, verified_at, check_count").eq("id", id).single();
    const v2 = await agreement.verifyAgreementSession(id);
    const { data: after2 } = await service.from("agreement_sessions").select("check_count").eq("id", id).single();
    console.log(`verify #1 -> ${v1.code} (status=${after1!.status}, verified_at=${after1!.verified_at}, DocuSign checks=${after1!.check_count})`);
    console.log(`verify #2 (immediate) -> ${v2.code} (DocuSign checks still=${after2!.check_count})`);
    expect(v1.ok).toBe(false);
    expect(v1.code).toBe("agreement_incomplete");
    expect(after1!.verified_at).toBeNull();
    expect(after1!.check_count).toBe(2);
    expect(v2.code).toBe("throttled");
    expect(after2!.check_count).toBe(2);

    const gate = await agreement.checkAgreementForCheckout(id, EMAIL);
    console.log(`checkout gate on unsigned session -> ${gate.ok ? "OPEN" : gate.code}`);
    expect(gate.ok).toBe(false);
  });

  it("daily cleanup voids an unsigned envelope past its window", async () => {
    const id = sessionIds[0];
    await service.from("agreement_sessions").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", id);
    const r = await agreement.voidAbandonedAgreements();
    const { data: row } = await service.from("agreement_sessions").select("status, envelope_id").eq("id", id).single();
    const ds = await envelopes.getAgreementEnvelope(row!.envelope_id as string);
    console.log(`cleanup -> checked=${r.checked} voided=${r.voided} errors=${r.errors.length} | our row=${row!.status} | DocuSign envelope=${ds.status}`);
    expect(row!.status).toBe("voided");
    expect(ds.status).toBe("voided");
  });
});
