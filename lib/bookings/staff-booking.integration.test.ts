/**
 * Integration test — admin manual bookings + manual/detected payment RPCs,
 * against the linked Supabase project. DB writes only: no QuickBooks, no
 * Quo/Resend (it calls the RPCs directly, not the server actions), so per the
 * DB-mutating-test standard it's gated by CL_RUN_DB_TESTS=1 alone.
 *
 * Every staff call goes through PostgREST with a REAL signed-in staff/owner
 * session (role `authenticated`, auth.uid() = that user) — never service_role
 * or a superuser connection, which would bypass the is_staff() guards and the
 * EXECUTE grants this is meant to prove.
 *
 * Staff login: CL_TEST_STAFF_EMAIL / CL_TEST_STAFF_PASSWORD, falling back to
 * SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD.
 *
 *   CL_RUN_DB_TESTS=1 npx vitest run lib/bookings/staff-booking.integration.test.ts
 *
 * Cleanup: every created booking/customer id is tracked as it's created and
 * deleted independently in afterAll (each step its own try/catch).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const RUN = process.env.CL_RUN_DB_TESTS === "1";
const MARKER = `__staff_booking_test__${Date.now()}`;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const staffEmail = process.env.CL_TEST_STAFF_EMAIL ?? process.env.SEED_OWNER_EMAIL;
const staffPassword = process.env.CL_TEST_STAFF_PASSWORD ?? process.env.SEED_OWNER_PASSWORD;

const SIZE = "10yd";
// Far enough out that no real booking is there. Offsets are spaced > 6 days
// apart where a test needs free inventory: a 5-day rental + the buffer day
// blocks a unit for 7 calendar days (the concurrency test sells out offset 2).
function farDate(offsetDays: number): string {
  const d = new Date(Date.UTC(2027, 5, 1) + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!RUN)("admin manual bookings + payment RPCs (real staff session)", () => {
  let service: SupabaseClient;
  let staff: SupabaseClient;
  let anon: SupabaseClient;
  let staffId: string;
  const bookingIds: string[] = [];
  const customerIds = new Set<string>();

  async function track(bookingId: string) {
    bookingIds.push(bookingId);
    const { data } = await service
      .from("bookings")
      .select("customer_id")
      .eq("id", bookingId)
      .single();
    if (data?.customer_id) customerIds.add(data.customer_id as string);
  }

  function staffArgs(date: string, extra: Record<string, unknown> = {}) {
    return {
      p_size: SIZE,
      p_delivery_date: date,
      p_delivery_address: `1 ${MARKER} St, Columbus, OH 43004`,
      p_contact_name: `Staff Test ${MARKER}`,
      p_rental_days: 5,
      p_contact_phone: "6145550100",
      p_contact_email: `${MARKER}@example.com`,
      p_sms_consent: false,
      ...extra,
    };
  }

  beforeAll(async () => {
    if (!staffEmail || !staffPassword) {
      throw new Error("Need CL_TEST_STAFF_EMAIL/PASSWORD or SEED_OWNER_EMAIL/PASSWORD.");
    }
    service = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    anon = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    staff = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await staff.auth.signInWithPassword({
      email: staffEmail,
      password: staffPassword,
    });
    if (error) throw new Error(`staff sign-in failed: ${error.message}`);
    staffId = data.user!.id;
  });

  afterAll(async () => {
    if (!service) return;
    for (const id of bookingIds) {
      const { data: jobs } = await service.from("jobs").select("id").eq("booking_id", id);
      const jobIds = (jobs ?? []).map((j) => j.id as string);
      for (const step of [
        () => service.from("status_log").delete().in("entity_id", jobIds.length ? jobIds : ["00000000-0000-0000-0000-000000000000"]),
        () => service.from("status_log").delete().eq("entity_id", id),
        () => service.from("invoices").delete().eq("booking_id", id),
        () => service.from("jobs").delete().eq("booking_id", id),
        () => service.from("bookings").delete().eq("id", id),
      ]) {
        try {
          const { error } = await step();
          if (error) console.error(`[cleanup] booking ${id}:`, error.message);
        } catch (e) {
          console.error(`[cleanup] booking ${id}:`, (e as Error).message);
        }
      }
    }
    for (const id of Array.from(customerIds)) {
      try {
        const { error } = await service.from("customers").delete().eq("id", id);
        if (error) console.error(`[cleanup] customer ${id}:`, error.message);
      } catch (e) {
        console.error(`[cleanup] customer ${id}:`, (e as Error).message);
      }
    }
  });

  it("anon cannot execute any service-only or staff RPC", async () => {
    const zero = "00000000-0000-0000-0000-000000000000";
    const calls: Array<[string, Record<string, unknown>]> = [
      ["record_payment", { p_booking_id: zero, p_qb_charge_id: "x", p_qb_payment_id: null, p_amount: 1 }],
      ["record_invoice_synced", { p_booking_id: zero, p_qb_invoice_id: "x" }],
      ["create_booking", staffArgs(farDate(0))],
      ["staff_create_booking", staffArgs(farDate(0))],
      ["record_manual_payment", { p_booking_id: zero, p_method: "cash" }],
      ["record_invoice_payment_detected", { p_booking_id: zero, p_qb_invoice_id: "x", p_qb_payment_id: null }],
    ];
    for (const [fn, args] of calls) {
      const { error } = await anon.rpc(fn, args);
      console.log(`anon rpc ${fn} ->`, error?.code, error?.message);
      expect(error?.code, fn).toBe("42501");
    }
  });

  it("staff_create_booking: unpaid, source=staff, audit = staff, customer NOT linked to staff login", async () => {
    const date = farDate(0);
    const { data: bookingId, error } = await staff.rpc("staff_create_booking", staffArgs(date));
    expect(error).toBeNull();
    await track(bookingId as string);

    const { data: b } = await service
      .from("bookings")
      .select("payment_status, source, created_by, status, delivery_date, pickup_date, total, customer_id, customers(profile_id)")
      .eq("id", bookingId)
      .single();
    const { data: quote } = await service.rpc("booking_quote", { p_size: SIZE });
    const q = Array.isArray(quote) ? quote[0] : quote;
    const { data: log } = await service
      .from("status_log")
      .select("new_status, changed_by")
      .eq("entity_id", bookingId);
    console.log("staff booking row:", JSON.stringify(b), "\nstatus_log:", JSON.stringify(log), "\nquote total:", q.total);

    expect(b!.payment_status).toBe("unpaid");
    expect(b!.source).toBe("staff");
    expect(b!.created_by).toBe(staffId);
    expect(b!.status).toBe("confirmed");
    expect((b!.customers as unknown as { profile_id: string | null }).profile_id).toBeNull();
    expect(Number(b!.total)).toBe(Number(q.total));
    const pickup = new Date(Date.parse(date) + 5 * 86_400_000).toISOString().slice(0, 10);
    expect(b!.pickup_date).toBe(pickup);
    expect(log).toEqual([{ new_status: "confirmed", changed_by: staffId }]);
  });

  it("staff_create_booking enforces the tomorrow floor", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await staff.rpc("staff_create_booking", staffArgs(today));
    if (data) await track(data as string);
    console.log("today ->", error?.code, error?.message, error?.hint);
    expect(error?.hint).toBe("unavailable");
  });

  it("online create_booking (service role, as payAndBook calls it) still works: source=online", async () => {
    const { data: bookingId, error } = await service.rpc("create_booking", staffArgs(farDate(1)));
    expect(error).toBeNull();
    await track(bookingId as string);
    const { data: b } = await service
      .from("bookings")
      .select("payment_status, source, created_by")
      .eq("id", bookingId)
      .single();
    console.log("online booking row:", JSON.stringify(b));
    expect(b).toEqual({ payment_status: "unpaid", source: "online", created_by: null });
  });

  it("shared lock: parallel online + staff creates never exceed availability", async () => {
    const date = farDate(2);
    const { data: avail } = await service.rpc("size_availability", {
      p_size: SIZE,
      p_from: date,
      p_to: date,
      p_rental_days: 5,
    });
    const a = (avail as Array<{ total: number; committed: number }>)[0];
    const free = a.total - a.committed;
    const attempts = free + 2;
    console.log(`date ${date}: total=${a.total} committed=${a.committed} free=${free}; firing ${attempts} parallel creates`);

    const results = await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        i % 2 === 0
          ? staff.rpc("staff_create_booking", staffArgs(date))
          : service.rpc("create_booking", staffArgs(date)),
      ),
    );
    for (const r of results) if (r.data) await track(r.data as string);
    const ok = results.filter((r) => !r.error).length;
    const rejected = results.filter((r) => r.error?.hint === "unavailable").length;
    console.log(`succeeded=${ok} rejected_unavailable=${rejected} other_errors=${attempts - ok - rejected}`);
    expect(ok).toBe(free);
    expect(rejected).toBe(attempts - free);
  });

  it("record_manual_payment: check # + who; second attempt refused", async () => {
    const { data: bookingId, error: createErr } = await staff.rpc("staff_create_booking", staffArgs(farDate(30)));
    expect(createErr).toBeNull();
    await track(bookingId as string);

    const { error } = await staff.rpc("record_manual_payment", {
      p_booking_id: bookingId,
      p_method: "check",
      p_reference: "1042",
      p_note: "handed to driver",
    });
    expect(error).toBeNull();

    const { data: inv } = await service
      .from("invoices")
      .select("status, amount, payment_method, payment_reference, payment_note, recorded_by, sync_status, paid_at")
      .eq("booking_id", bookingId)
      .single();
    const { data: b } = await service.from("bookings").select("payment_status, total").eq("id", bookingId).single();
    console.log("after cash/check:", JSON.stringify(inv), JSON.stringify(b));
    expect(b!.payment_status).toBe("paid");
    expect(inv).toMatchObject({
      status: "paid",
      payment_method: "check",
      payment_reference: "1042",
      payment_note: "handed to driver",
      recorded_by: staffId,
      sync_status: "pending",
    });
    expect(Number(inv!.amount)).toBe(Number(b!.total));

    const again = await staff.rpc("record_manual_payment", { p_booking_id: bookingId, p_method: "cash" });
    console.log("second record ->", again.error?.code, again.error?.hint, again.error?.message);
    expect(again.error?.hint).toBe("already_paid");

    const badMethod = await staff.rpc("record_manual_payment", { p_booking_id: bookingId, p_method: "venmo" });
    expect(badMethod.error?.code).toBe("22023");

    const issue = await staff.rpc("record_invoice_issued", {
      p_booking_id: bookingId,
      p_qb_invoice_id: "TEST",
      p_invoice_link: null,
      p_sent_to: "x@example.com",
    });
    expect(issue.error?.hint).toBe("not_unpaid");
  });

  it("pay-link path: issued -> detected flips once; staff can't call detection; late cash refused", async () => {
    const { data: bookingId, error: createErr } = await staff.rpc("staff_create_booking", staffArgs(farDate(45)));
    expect(createErr).toBeNull();
    await track(bookingId as string);
    const qbId = `TEST-${Date.now()}`;

    const { error: issueErr } = await staff.rpc("record_invoice_issued", {
      p_booking_id: bookingId,
      p_qb_invoice_id: qbId,
      p_invoice_link: "https://example.invalid/pay",
      p_sent_to: `${MARKER}@example.com`,
    });
    expect(issueErr).toBeNull();
    const { data: issued } = await service
      .from("invoices")
      .select("status, quickbooks_invoice_id, sync_status, invoice_sent_to, invoice_sent_at, qb_invoice_link")
      .eq("booking_id", bookingId)
      .single();
    console.log("issued:", JSON.stringify(issued));
    expect(issued).toMatchObject({ status: "pending", quickbooks_invoice_id: qbId, sync_status: "synced" });
    expect(issued!.invoice_sent_at).not.toBeNull();

    const staffDetect = await staff.rpc("record_invoice_payment_detected", {
      p_booking_id: bookingId,
      p_qb_invoice_id: qbId,
      p_qb_payment_id: "P1",
    });
    console.log("staff calling detection ->", staffDetect.error?.code, staffDetect.error?.message);
    expect(staffDetect.error?.code).toBe("42501");

    const first = await service.rpc("record_invoice_payment_detected", {
      p_booking_id: bookingId,
      p_qb_invoice_id: qbId,
      p_qb_payment_id: "P1",
    });
    const second = await service.rpc("record_invoice_payment_detected", {
      p_booking_id: bookingId,
      p_qb_invoice_id: qbId,
      p_qb_payment_id: "P1",
    });
    console.log("detected first/second:", first.data, second.data);
    expect(first.data).toBe(true);
    expect(second.data).toBe(false);

    const { data: inv } = await service
      .from("invoices")
      .select("status, payment_method, qb_payment_id, recorded_by")
      .eq("booking_id", bookingId)
      .single();
    expect(inv).toEqual({ status: "paid", payment_method: "qbo_invoice", qb_payment_id: "P1", recorded_by: null });

    const lateCash = await staff.rpc("record_manual_payment", { p_booking_id: bookingId, p_method: "cash" });
    expect(lateCash.error?.hint).toBe("already_paid");
  });

  it("race the other way: cash recorded first, then detection is a no-op", async () => {
    const { data: bookingId, error: createErr } = await staff.rpc("staff_create_booking", staffArgs(farDate(60)));
    expect(createErr).toBeNull();
    await track(bookingId as string);
    const qbId = `TEST-${Date.now()}`;
    await staff.rpc("record_invoice_issued", {
      p_booking_id: bookingId,
      p_qb_invoice_id: qbId,
      p_invoice_link: null,
      p_sent_to: `${MARKER}@example.com`,
    });
    const { error } = await staff.rpc("record_manual_payment", { p_booking_id: bookingId, p_method: "cash" });
    expect(error).toBeNull();
    const det = await service.rpc("record_invoice_payment_detected", {
      p_booking_id: bookingId,
      p_qb_invoice_id: qbId,
      p_qb_payment_id: "P2",
    });
    const { data: inv } = await service
      .from("invoices")
      .select("payment_method, quickbooks_invoice_id, qb_payment_id")
      .eq("booking_id", bookingId)
      .single();
    console.log("detect after cash ->", det.data, JSON.stringify(inv));
    expect(det.data).toBe(false);
    // The already-sent QBO invoice id is kept so the QBO sync posts the cash
    // Payment against THAT invoice instead of creating a second one.
    expect(inv).toEqual({ payment_method: "cash", quickbooks_invoice_id: qbId, qb_payment_id: null });
  });
});
