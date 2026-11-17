/**
 * Integration test — 'signed-agreements' bucket access + retention rules,
 * against the linked Supabase project. No DocuSign calls (fixture sessions
 * have no envelope id). DB/Storage writes only -> gated by CL_RUN_DB_TESTS=1.
 *
 *   CL_RUN_DB_TESTS=1 npx vitest run lib/docusign/agreement-storage.integration.test.ts
 *
 * Proves, through real sessions (never service_role for the access checks):
 *   - staff can mint a signed URL and download the PDF
 *   - staff can NOT upload, overwrite or delete (read-only bucket)
 *   - anon can NOT read/list/sign
 *   - a signed-in NON-staff user sees nothing (SQL as role authenticated)
 *   - unbooked signed agreements older than 30 days are deleted (PDF + row);
 *     a BOOKED one of the same age is never touched
 * Cleanup: every fixture object/session/booking/customer removed independently.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const RUN = process.env.CL_RUN_DB_TESTS === "1";
const BUCKET = "signed-agreements";
const MARKER = `__agreement_storage_test__${Date.now()}`;
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "latin1",
);

describe.skipIf(!RUN)("signed-agreements storage: access + retention", () => {
  let service: SupabaseClient;
  let staff: SupabaseClient;
  let anon: SupabaseClient;
  const paths: string[] = [];
  const sessionIds: string[] = [];
  let bookingId: string | null = null;
  let customerId: string | null = null;

  async function fixtureSession(opts: { daysAgo: number; booked: boolean }): Promise<{ id: string; path: string }> {
    const id = randomUUID();
    const path = `${id}/signed-agreement.pdf`;
    const { error: upErr } = await service.storage.from(BUCKET).upload(path, PDF, { contentType: "application/pdf" });
    if (upErr) throw new Error(`fixture upload: ${upErr.message}`);
    paths.push(path);
    const at = new Date(Date.now() - opts.daysAgo * 86_400_000).toISOString();
    const { error } = await service.from("agreement_sessions").insert({
      id,
      envelope_id: null,
      signer_name: "ZZ Storage Test",
      signer_email: `${MARKER.toLowerCase()}@example.com`,
      status: "completed",
      completed_at: at,
      verified_at: at,
      document_path: path,
      document_stored_at: at,
      consumed_booking_id: opts.booked ? bookingId : null,
      consumed_at: opts.booked ? at : null,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    if (error) throw new Error(`fixture session: ${error.message}`);
    sessionIds.push(id);
    return { id, path };
  }

  beforeAll(async () => {
    const opts = { auth: { persistSession: false, autoRefreshToken: false } };
    service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, opts);
    anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, opts);
    staff = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, opts);
    const email = process.env.CL_TEST_STAFF_EMAIL ?? process.env.SEED_OWNER_EMAIL;
    const password = process.env.CL_TEST_STAFF_PASSWORD ?? process.env.SEED_OWNER_PASSWORD;
    const { error } = await staff.auth.signInWithPassword({ email: email!, password: password! });
    if (error) throw new Error(`staff sign-in: ${error.message}`);

    const { data: c } = await service.from("customers").insert({ full_name: "ZZ Storage Test", email: `${MARKER.toLowerCase()}@example.com` }).select("id").single();
    customerId = c!.id;
    const { data: b, error: bErr } = await service
      .from("bookings")
      .insert({ customer_id: customerId, size_requested: "10yd", delivery_address: MARKER, delivery_date: "2027-12-01", pickup_date: "2027-12-06", status: "confirmed", docusign_status: "signed" })
      .select("id")
      .single();
    if (bErr) throw new Error(`fixture booking: ${bErr.message}`);
    bookingId = b!.id;
  });

  afterAll(async () => {
    if (!service) return;
    for (const p of paths) {
      try { await service.storage.from(BUCKET).remove([p]); } catch (e) { console.error("[cleanup] object", (e as Error).message); }
    }
    for (const id of sessionIds) {
      try { await service.from("agreement_sessions").delete().eq("id", id); } catch (e) { console.error("[cleanup] session", (e as Error).message); }
    }
    if (bookingId) {
      try { await service.from("status_log").delete().eq("entity_id", bookingId); } catch { /* none */ }
      try { await service.from("bookings").delete().eq("id", bookingId); } catch (e) { console.error("[cleanup] booking", (e as Error).message); }
    }
    if (customerId) {
      try { await service.from("customers").delete().eq("id", customerId); } catch (e) { console.error("[cleanup] customer", (e as Error).message); }
    }
  });

  it("staff can mint a 60s signed URL and download the PDF", async () => {
    // unbooked + fresh: the booking fixture is reserved for the 30-day test
    // (consumed_booking_id is unique — one agreement per booking).
    const { path } = await fixtureSession({ daysAgo: 0, booked: false });
    const { data, error } = await staff.storage.from(BUCKET).createSignedUrl(path, 60);
    expect(error).toBeNull();
    const res = await fetch(data!.signedUrl);
    const body = Buffer.from(await res.arrayBuffer());
    console.log(`staff signed URL -> HTTP ${res.status}, content-type ${res.headers.get("content-type")}, starts with %PDF: ${body.subarray(0, 5).toString("latin1") === "%PDF-"}, url expires param present: ${/token=/.test(data!.signedUrl)}`);
    expect(res.status).toBe(200);
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("staff can NOT upload, overwrite or delete (read-only)", async () => {
    const existing = paths[0];
    const up = await staff.storage.from(BUCKET).upload(`${randomUUID()}/signed-agreement.pdf`, PDF, { contentType: "application/pdf" });
    const over = await staff.storage.from(BUCKET).upload(existing, PDF, { contentType: "application/pdf", upsert: true });
    const del = await staff.storage.from(BUCKET).remove([existing]);
    const { data: still } = await service.storage.from(BUCKET).list(existing.split("/")[0]);
    console.log(`staff upload -> ${up.error?.message ?? "ALLOWED"} | staff overwrite -> ${over.error?.message ?? "ALLOWED"} | staff delete -> returned ${JSON.stringify(del.data)} ${del.error?.message ?? ""}| object still exists: ${(still ?? []).some((o) => o.name === "signed-agreement.pdf")}`);
    expect(up.error).not.toBeNull();
    expect(over.error).not.toBeNull();
    expect((still ?? []).some((o) => o.name === "signed-agreement.pdf")).toBe(true);
  });

  it("anon can NOT sign, download or list", async () => {
    const p = paths[0];
    const signed = await anon.storage.from(BUCKET).createSignedUrl(p, 60);
    const dl = await anon.storage.from(BUCKET).download(p);
    const ls = await anon.storage.from(BUCKET).list(p.split("/")[0]);
    console.log(`anon signed URL -> ${signed.error?.message ?? "ALLOWED"} | anon download -> ${dl.error ? "denied" : "ALLOWED"} | anon list -> ${JSON.stringify(ls.data)}`);
    expect(signed.error).not.toBeNull();
    expect(dl.error).not.toBeNull();
    expect(ls.data ?? []).toEqual([]);
  });

  it("a signed-in NON-staff user sees no objects in the bucket (SQL as role authenticated)", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query(`set local request.jwt.claims = '{"sub":"11111111-2222-3333-4444-555555555555","role":"authenticated"}'`);
      const staffCheck = await client.query("select public.is_staff() as s");
      const r = await client.query("select count(*)::int as n from storage.objects where bucket_id = $1", [BUCKET]);
      console.log(`non-staff authenticated: is_staff=${staffCheck.rows[0].s}, visible objects=${r.rows[0].n}`);
      expect(staffCheck.rows[0].s).toBe(false);
      expect(r.rows[0].n).toBe(0);
      await client.query("rollback");
    } finally {
      client.release();
      await pool.end();
    }
  });

  it("30-day rule: unbooked signed agreement deleted (PDF + row); booked one of the same age kept", async () => {
    const unbooked = await fixtureSession({ daysAgo: 31, booked: false });
    const booked = await fixtureSession({ daysAgo: 31, booked: true });
    const fresh = await fixtureSession({ daysAgo: 5, booked: false });
    const { deleteUnbookedSignedAgreements } = await import("./agreement");
    const r = await deleteUnbookedSignedAgreements();
    const rowsLeft = async (id: string) => (await service.from("agreement_sessions").select("id").eq("id", id)).data?.length ?? 0;
    const objLeft = async (path: string) =>
      ((await service.storage.from(BUCKET).list(path.split("/")[0])).data ?? []).some((o) => o.name === "signed-agreement.pdf");
    const out = {
      unbooked31d: { row: await rowsLeft(unbooked.id), pdf: await objLeft(unbooked.path) },
      booked31d: { row: await rowsLeft(booked.id), pdf: await objLeft(booked.path) },
      unbooked5d: { row: await rowsLeft(fresh.id), pdf: await objLeft(fresh.path) },
    };
    console.log(`cleanup -> checked=${r.checked} deleted=${r.deleted} errors=${r.errors.length} | ${JSON.stringify(out)}`);
    expect(out.unbooked31d).toEqual({ row: 0, pdf: false });
    expect(out.booked31d).toEqual({ row: 1, pdf: true });
    expect(out.unbooked5d).toEqual({ row: 1, pdf: true });
  });
});
