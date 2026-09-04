/**
 * Integration test — hits the linked Supabase project.
 *
 * Opt-in: runs only when CL_RUN_DB_TESTS=1. It also needs a staff/owner login
 * because set_booking_status enforces is_staff():
 *   CL_TEST_STAFF_EMAIL, CL_TEST_STAFF_PASSWORD
 * Put all three in .env.local, then:  CL_RUN_DB_TESTS=1 npm test
 *
 * Why this exists: the pickup-job-on-pickup_scheduled logic was missing
 * entirely, and tsc + build + the pure state-machine tests all passed anyway.
 * This asserts the side effect actually happens against a real database.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const RUN = process.env.CL_RUN_DB_TESTS === "1";
const MARKER = `__pj_integration_test__${Date.now()}`;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const staffEmail = process.env.CL_TEST_STAFF_EMAIL;
const staffPassword = process.env.CL_TEST_STAFF_PASSWORD;

describe.skipIf(!RUN)("set_booking_status → pickup_scheduled creates a pickup job", () => {
  let service: SupabaseClient;
  let staff: SupabaseClient;
  let bookingId: string;
  let customerId: string;
  let pickupDate: string;

  beforeAll(async () => {
    if (!staffEmail || !staffPassword) {
      throw new Error(
        "CL_RUN_DB_TESTS=1 but CL_TEST_STAFF_EMAIL / CL_TEST_STAFF_PASSWORD are not set. " +
          "set_booking_status needs a staff/owner session.",
      );
    }

    service = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    staff = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: signInErr } = await staff.auth.signInWithPassword({
      email: staffEmail,
      password: staffPassword,
    });
    if (signInErr) throw new Error(`staff sign-in failed: ${signInErr.message}`);

    // Fixture: a booking already 'active', built directly (no create_booking /
    // pricing dependency). dumpster_id NULL, so no exclusion-constraint concern.
    const delivery = "2027-01-04";
    pickupDate = "2027-01-08";

    const { data: cust, error: custErr } = await service
      .from("customers")
      .insert({ full_name: `PJ Test ${MARKER}`, email: `${MARKER}@example.com` })
      .select("id")
      .single();
    if (custErr) throw new Error(`fixture customer: ${custErr.message}`);
    customerId = cust!.id;

    const { data: bk, error: bkErr } = await service
      .from("bookings")
      .insert({
        customer_id: customerId,
        size_requested: "20yd",
        delivery_address: MARKER,
        delivery_date: delivery,
        pickup_date: pickupDate,
        status: "active",
      })
      .select("id")
      .single();
    if (bkErr) throw new Error(`fixture booking: ${bkErr.message}`);
    bookingId = bk!.id;

    await service.from("jobs").insert({
      booking_id: bookingId,
      type: "delivery",
      scheduled_date: delivery,
      status: "unassigned",
    });
  });

  // Cleanup must run — and must clean up whatever actually got created — no
  // matter how far beforeAll got or which `it()` failed an assertion:
  //  - vitest runs afterAll after every test in the describe block regardless
  //    of pass/fail, AND even if beforeAll itself threw partway through. So
  //    a failed expect() inside an it() is never a cleanup risk here: bookingId
  //    / customerId are set once in beforeAll, not touched by test outcomes.
  //  - the real risk is a PARTIAL beforeAll (e.g. the customer insert
  //    succeeds but the booking insert then throws) — this used to gate the
  //    entire cleanup on `if (!bookingId) return`, which would silently
  //    orphan the customer row. Each step below is now independently guarded
  //    and independently fault-tolerant, so it deletes everything that got
  //    created, in dependency order, and one step failing can't block the rest.
  afterAll(async () => {
    const step = async (label: string, fn: () => PromiseLike<{ error: unknown }>) => {
      try {
        const { error } = await fn();
        if (error) console.error(`[pickup-job cleanup] ${label} failed:`, error);
      } catch (e) {
        console.error(`[pickup-job cleanup] ${label} threw:`, (e as Error).message);
      }
    };

    if (bookingId) {
      const { data: jobIds } = await service
        .from("jobs")
        .select("id")
        .eq("booking_id", bookingId);
      const ids = (jobIds ?? []).map((j) => j.id);
      if (ids.length) {
        await step("job status_log", () =>
          service.from("status_log").delete().eq("entity_type", "job").in("entity_id", ids),
        );
      }
      await step("booking status_log", () =>
        service.from("status_log").delete().eq("entity_type", "booking").eq("entity_id", bookingId),
      );
      await step("jobs", () => service.from("jobs").delete().eq("booking_id", bookingId));
      await step("booking", () => service.from("bookings").delete().eq("id", bookingId));
    }
    if (customerId) {
      await step("customer", () => service.from("customers").delete().eq("id", customerId));
    }
  });

  it("creates exactly one pickup job with scheduled_date = pickup_date", async () => {
    const { error } = await staff.rpc("set_booking_status", {
      p_booking_id: bookingId,
      p_to: "pickup_scheduled",
    });
    expect(error, error?.message).toBeNull();

    const { data: pickups } = await service
      .from("jobs")
      .select("id, status, scheduled_date")
      .eq("booking_id", bookingId)
      .eq("type", "pickup");

    expect(pickups).toHaveLength(1);
    expect(pickups![0].status).toBe("unassigned");
    expect(pickups![0].scheduled_date).toBe(pickupDate);

    const { data: logs } = await service
      .from("status_log")
      .select("id")
      .eq("entity_type", "job")
      .eq("entity_id", pickups![0].id);
    expect(logs).toHaveLength(1);
  });

  it("does not create a second pickup job when the state is re-entered", async () => {
    // pickup_scheduled -> overdue -> pickup_scheduled
    for (const to of ["overdue", "pickup_scheduled"] as const) {
      const { error } = await staff.rpc("set_booking_status", {
        p_booking_id: bookingId,
        p_to: to,
      });
      expect(error, error?.message).toBeNull();
    }

    const { data: pickups } = await service
      .from("jobs")
      .select("id")
      .eq("booking_id", bookingId)
      .eq("type", "pickup");
    expect(pickups).toHaveLength(1);
  });
});
