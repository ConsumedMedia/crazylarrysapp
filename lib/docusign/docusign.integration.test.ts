/**
 * Integration test — DocuSign eSignature client against the SANDBOX account.
 *
 *   CL_RUN_DOCUSIGN_TESTS=1 npx vitest run lib/docusign/docusign.integration.test.ts
 *
 * Refuses to run unless DOCUSIGN_ENVIRONMENT=sandbox. Creates real sandbox
 * envelopes addressed to @example.com embedded signers (embedded recipients
 * are not emailed a signing link), and VOIDS every envelope it created in
 * afterAll — tracked as each is created, each void independently guarded.
 * Never logs the key, assertion or access token.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const RUN = process.env.CL_RUN_DOCUSIGN_TESTS === "1";

describe.skipIf(!RUN)("DocuSign client (sandbox)", () => {
  const created: string[] = [];
  let ds: typeof import("./envelopes");
  let auth: typeof import("./auth");

  beforeAll(async () => {
    if (process.env.DOCUSIGN_ENVIRONMENT !== "sandbox") {
      throw new Error("Refusing to run: DOCUSIGN_ENVIRONMENT must be 'sandbox'.");
    }
    ds = await import("./envelopes");
    auth = await import("./auth");
  });

  afterAll(async () => {
    for (const id of created) {
      try {
        const s = await ds.getAgreementEnvelope(id);
        if (!["voided", "completed", "declined"].includes(s.status)) {
          await ds.voidAgreementEnvelope(id, "Automated test cleanup");
        }
        console.log(`[cleanup] envelope ${id.slice(0, 8)}… -> ${(await ds.getAgreementEnvelope(id)).status}`);
      } catch (e) {
        console.error(`[cleanup] envelope ${id}:`, (e as Error).message);
      }
    }
  });

  it("JWT grant returns a token and caches it until near expiry", async () => {
    const t1 = await auth.getDocusignAccessToken();
    const exp1 = auth.cachedDocusignTokenExpiresAt();
    const t2 = await auth.getDocusignAccessToken();
    const exp2 = auth.cachedDocusignTokenExpiresAt();
    console.log(`token length=${t1.length}, expires in ${Math.round(((exp1 ?? 0) - Date.now()) / 1000)}s, second call reused cache=${t1 === t2 && exp1 === exp2}`);
    expect(t1.length).toBeGreaterThan(100);
    expect(t2).toBe(t1);
    expect(exp2).toBe(exp1);
  });

  it("resolves the agreement template from the PowerForm", async () => {
    const id = await ds.getAgreementTemplateId();
    console.log(`template id resolved: ${id.slice(0, 8)}…`);
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("creates an envelope with the server-set embedded signer, issues a signing URL, reads it back, voids it", async () => {
    const sessionId = randomUUID();
    const email = `ds-client-test-${Date.now()}@example.com`;
    const { envelopeId } = await ds.createAgreementEnvelope({
      sessionId,
      signerName: "ZZ DocuSign Client Test",
      signerEmail: email,
    });
    created.push(envelopeId);

    const state = await ds.getAgreementEnvelope(envelopeId);
    console.log("envelope state:", JSON.stringify({ ...state, signer: state.signer && { ...state.signer, email: state.signer.email === email ? "<matches>" : "<MISMATCH>" } }));
    expect(state.status).toBe("sent");
    expect(state.signer?.email).toBe(email);
    expect(state.signer?.clientUserId).toBe(sessionId);
    expect(state.sessionField).toBe(sessionId);
    expect(state.completedAt).toBeNull();

    const url = await ds.createSigningUrl({
      envelopeId,
      sessionId,
      signerName: "ZZ DocuSign Client Test",
      signerEmail: email,
      returnUrl: "http://localhost:3000/book/agreement/return?session=" + sessionId,
    });
    console.log(`signing url host: ${new URL(url).host}`);
    expect(new URL(url).host).toMatch(/docusign\.net$/);

    await ds.voidAgreementEnvelope(envelopeId, "Automated test");
    const after = await ds.getAgreementEnvelope(envelopeId);
    console.log(`after void: ${after.status}`);
    expect(after.status).toBe("voided");
  });
});
