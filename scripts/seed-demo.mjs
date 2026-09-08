/**
 * Crazy Larry's Dumpsters — Phase 10 QA/UAT demo reset + seed.
 *
 *   node scripts/seed-demo.mjs           # dry run: prints the plan, touches nothing
 *   node scripts/seed-demo.mjs --confirm # WIPES transactional data, then seeds
 *
 * What it does (only with --confirm):
 *   1. Removes all objects from the job-photos Storage bucket.
 *   2. Deletes every row from the transactional tables (see WIPE below), in FK
 *      order, in one transaction via a direct pg connection.
 *   3. Resets all 28 dumpsters to 'available' and writes one fresh opening
 *      status_log row per unit.
 *   4. Recreates 3 drivers (Marcus Webb / Danielle Cortez / Ray Sczepanski),
 *      reusing the retired "Driver Test" auth user for Marcus.
 *   5. Creates a throwaway owner ("seed-admin") to drive the lifecycle RPCs,
 *      then DELETES it at the end.
 *   6. Seeds 14 bookings across every lifecycle state through the real RPCs
 *      (create_booking / assign_job / complete_job / set_booking_status /
 *      mark_overdue_bookings / record_payment / ...), backdating past bookings.
 *   7. Prints verification: deployed map pins, today's driver routes, counts.
 *
 * NOTE: the seed does NOT hit Intuit or charge cards. Invoices are recorded via
 * record_payment with synthetic ids so the admin dashboards have realistic
 * content; the real payment + QuickBooks path is exercised from the QA checklist.
 */

import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import fs from "fs";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------
const env = Object.fromEntries(
  fs
    .readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const DATABASE_URL = env.DATABASE_URL;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !DATABASE_URL) {
  console.error("Missing one of NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY / SERVICE_ROLE_KEY / DATABASE_URL in .env.local");
  process.exit(1);
}

if (env.CL_NOTIFICATIONS_ENABLED === "1") {
  console.error(
    "\n  ✋ CL_NOTIFICATIONS_ENABLED=1 in .env.local. Set it to 0 before seeding\n" +
      "     so no SMS/email can fire. Aborting.\n",
  );
  process.exit(1);
}

const CONFIRM = process.argv.includes("--confirm");
const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// ---------------------------------------------------------------------------
// date helpers — "T" is right now, on the machine running this
// ---------------------------------------------------------------------------
const BASE = new Date();
function ymd(offsetDays) {
  const d = new Date(BASE);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
const FAR = ymd(45); // safe "create it here, then backdate" delivery date

// ---------------------------------------------------------------------------
// WIPE — tables emptied entirely, in FK-safe order
// ---------------------------------------------------------------------------
const WIPE_ORDER = [
  "job_photos",
  "payment_attempts",
  "notifications_log",
  "booking_change_requests",
  "invoices",
  "jobs",
  "status_log",
  "bookings",
  "customers",
  "call_transcripts",
  "drivers",
];

// ---------------------------------------------------------------------------
// DRIVERS
// ---------------------------------------------------------------------------
const DRIVERS = [
  { key: "marcus", name: "Marcus Webb", phone: "614-555-0142", truck: "Pepperoni", vehicle: "Chevrolet 6500 — Pepperoni", reuseDriverTest: true },
  { key: "danielle", name: "Danielle Cortez", phone: "614-555-0188", truck: "Kenny Powers", vehicle: "Kenworth T280 — Kenny Powers", email: "danielle.cortez@crazylarrys.test" },
  { key: "ray", name: "Ray Sczepanski", phone: "614-555-0207", truck: null, vehicle: "Relief driver — no assigned truck", email: "ray.sczepanski@crazylarrys.test" },
];

// ---------------------------------------------------------------------------
// BOOKINGS — the demo state. `lifecycle` drives which RPCs run.
//   deliveryOffset / pickupOffset are relative to T (negative = past).
//   driver: which driver runs the job(s). override: pass through assign_job.
// ---------------------------------------------------------------------------
const PORTAL_EMAIL = "rebecca.lund@example.com"; // 3 bookings, linked to a portal login

const BOOKINGS = [
  // ---- confirmed / upcoming ------------------------------------------------
  { ref: 1, lifecycle: "confirmed", size: "15yd", deliveryOffset: 2, rentalDays: 5,
    street: "1264 Grandview Ave", city: "Columbus", state: "OH", zip: "43212",
    name: "Rebecca Lund", email: PORTAL_EMAIL, phone: "614-555-0111",
    debris: "Garage and basement cleanout", notes: "Left side of the driveway, clear of the basketball hoop." },
  { ref: 2, lifecycle: "confirmed", size: "20yd", deliveryOffset: 4, rentalDays: 5,
    street: "6161 Huntley Rd", city: "Columbus", state: "OH", zip: "43229",
    name: "Dave Renner", company: "Keystone Property Group", email: "drenner@keystonepg.example.com", phone: "614-555-0126",
    debris: "Office furniture and carpet from a suite turnover", notes: "Loading dock, north side. Call on arrival." },
  { ref: 3, lifecycle: "confirmed_routed", size: "10yd", deliveryOffset: 1, rentalDays: 5, driver: "marcus",
    street: "2200 Tremont Rd", city: "Upper Arlington", state: "OH", zip: "43221",
    name: "Priya Nair", email: "priya.nair@example.com", phone: "614-555-0134",
    debris: "Hall bathroom remodel — tile, vanity, drywall", notes: "Driveway apron, do not block the sidewalk." },

  // ---- active / deployed (map pins + live rentals) -----------------------
  { ref: 4, lifecycle: "active", size: "20yd", deliveryOffset: -3, rentalDays: 6, driver: "marcus",
    street: "845 N 4th St", city: "Columbus", state: "OH", zip: "43215",
    name: "Tom Beckett", email: "tom.beckett@example.com", phone: "614-555-0158",
    debris: "Whole-house interior gut renovation", notes: "Street side, cones set out." },
  { ref: 5, lifecycle: "active", size: "15yd", deliveryOffset: -1, rentalDays: 6, driver: "danielle",
    street: "1500 W 3rd Ave", city: "Columbus", state: "OH", zip: "43212",
    name: "Rebecca Lund", email: PORTAL_EMAIL, phone: "614-555-0111",
    debris: "Kitchen remodel debris", notes: "Behind the gate, contractor has the code." },
  { ref: 6, lifecycle: "active", size: "10yd", deliveryOffset: -2, rentalDays: 4, driver: "marcus",
    street: "398 Dennison Ave", city: "Columbus", state: "OH", zip: "43215",
    name: "Rachel Osei", email: "rachel.osei@example.com", phone: "614-555-0163",
    debris: "Attic and garage cleanout", notes: "Gravel pad next to the garage." },
  { ref: 7, lifecycle: "active", size: "20yd", deliveryOffset: -5, rentalDays: 7, driver: "danielle",
    street: "2965 N High St", city: "Columbus", state: "OH", zip: "43202",
    name: "Greg Marsh", company: "Clintonville Community Market", email: "gmarsh@ccmarket.example.com", phone: "614-555-0171",
    debris: "Roofing shingles and underlayment tear-off", notes: "Rear lot by the compactor." },
  // #8 stays unassigned on purpose: it is the warn + override demo case for the
  // QA checklist (assign to Marcus/Pepperoni -> untagged_review -> override).
  { ref: 8, lifecycle: "confirmed", size: "20yd", deliveryOffset: 3, rentalDays: 6,
    street: "4900 Reed Rd", city: "Upper Arlington", state: "OH", zip: "43220",
    name: "Erin Vance", company: "Cardinal Remodeling LLC", email: "erin@cardinalremodeling.example.com", phone: "614-555-0179",
    debris: "Brick and masonry rubble from a chimney removal", notes: "Side yard, plywood down for the truck." },

  // ---- pickup_scheduled --------------------------------------------------
  { ref: 9, lifecycle: "pickup_routed", size: "20yd", deliveryOffset: -6, pickupOffset: 0, driver: "danielle",
    street: "77 E Nationwide Blvd", city: "Columbus", state: "OH", zip: "43215",
    name: "Paul Grimes", company: "Nationwide Realty Investors", email: "pgrimes@nri.example.com", phone: "614-555-0184",
    debris: "Event teardown and staging materials", notes: "Garage level P1, by the freight elevator." },
  { ref: 10, lifecycle: "pickup_unrouted", size: "15yd", deliveryOffset: -7, pickupOffset: 1,
    street: "1421 Grandview Ave", city: "Columbus", state: "OH", zip: "43212",
    name: "Harold Metz", email: "harold.metz@example.com", phone: "614-555-0192",
    debris: "Deck teardown", notes: "Alley access behind the house." },

  // ---- overdue ---------------------------------------------------------
  { ref: 11, lifecycle: "overdue", size: "10yd", deliveryOffset: -12, pickupOffset: -3, driver: "marcus",
    street: "3040 Indianola Ave", city: "Columbus", state: "OH", zip: "43202",
    name: "Denise Falk", email: "denise.falk@example.com", phone: "614-555-0198",
    debris: "Yard waste and fencing", notes: "Front curb." },

  // ---- returned (booking history depth) --------------------------------
  { ref: 12, lifecycle: "returned", size: "20yd", deliveryOffset: -25, pickupOffset: -18, driver: "marcus",
    street: "1580 King Ave", city: "Columbus", state: "OH", zip: "43212",
    name: "Rebecca Lund", email: PORTAL_EMAIL, phone: "614-555-0111",
    debris: "Rental property turnover", notes: "" },
  { ref: 13, lifecycle: "returned", size: "15yd", deliveryOffset: -20, pickupOffset: -14, driver: "danielle",
    street: "2100 Arlington Ave", city: "Upper Arlington", state: "OH", zip: "43221",
    name: "Bill Shaffer", company: "Shaffer Construction", email: "bill@shafferconstruction.example.com", phone: "614-555-0203",
    debris: "General construction debris", notes: "Jobsite — see the super." },
  { ref: 14, lifecycle: "returned", size: "10yd", deliveryOffset: -15, pickupOffset: -9, driver: "marcus",
    street: "660 Grant Ave", city: "Columbus", state: "OH", zip: "43215",
    name: "Angela Poe", company: "Metro Dental Partners", email: "apoe@metrodental.example.com", phone: "614-555-0209",
    debris: "Office remodel — millwork and flooring", notes: "Dumpster in the rear parking row." },
];

// ---------------------------------------------------------------------------
// dry run
// ---------------------------------------------------------------------------
if (!CONFIRM) {
  console.log("DRY RUN — nothing will be changed. Re-run with --confirm to execute.\n");
  console.log(`"T" (today) resolves to ${ymd(0)}\n`);
  console.log("WIPE (all rows):", WIPE_ORDER.join(", "));
  console.log("           plus: all objects in the job-photos Storage bucket");
  console.log("      reset:  dumpsters.status -> 'available' (28 units) + fresh status_log opening rows\n");
  console.log("DRIVERS:", DRIVERS.map((d) => `${d.name}${d.truck ? " / " + d.truck : " / (relief, no truck)"}`).join("  |  "));
  console.log("\nBOOKINGS:");
  for (const b of BOOKINGS) {
    const dd = ymd(b.deliveryOffset);
    console.log(
      `  #${String(b.ref).padStart(2)}  ${b.lifecycle.padEnd(16)} ${b.size}  ${dd}  ${(b.company ? b.company + " / " : "") + b.name}  — ${b.street}, ${b.city}`,
    );
  }
  console.log(`\nPortal demo login will be created: ${PORTAL_EMAIL} (bookings #1, #5, #12)`);
  process.exit(0);
}

// ===========================================================================
// EXECUTE
// ===========================================================================
const log = (...a) => console.log(...a);
const SEED_ADMIN_EMAIL = `seed-admin+${Date.now()}@crazylarrys.test`;
const SEED_ADMIN_PW = crypto.randomBytes(18).toString("base64url");
let seedAdminId = null;

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // ---- 1. storage cleanup -------------------------------------------------
  log("\n[1/7] Clearing job-photos storage bucket…");
  await clearBucket("job-photos");

  // ---- 2. wipe + 3. dumpster reset (one tx) -----------------------------
  log("[2/7] Wiping transactional tables…");
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const t of WIPE_ORDER) {
      const r = await client.query(`delete from public.${t}`);
      log(`        ${t.padEnd(24)} ${r.rowCount} rows`);
    }
    log("[3/7] Resetting 28 dumpsters to 'available' + opening status_log rows…");
    await client.query(`update public.dumpsters set status = 'available' where status <> 'available'`);
    await client.query(`
      insert into public.status_log (entity_type, entity_id, old_status, new_status, changed_by)
      select 'dumpster', id, null, 'available', null from public.dumpsters
    `);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }

  // ---- 4. drivers ------------------------------------------------------
  log("[4/7] Recreating drivers…");
  const driverIds = {};
  const { data: trucks } = await svc.from("trucks").select("id, nickname");
  const truckByName = Object.fromEntries((trucks ?? []).map((t) => [t.nickname, t.id]));
  // clear truck assignments first (unique constraint)
  await svc.from("trucks").update({ assigned_driver_id: null }).not("id", "is", null);

  // reuse the retired "Driver Test" auth user for Marcus: oldest driver-role profile
  const { rows: existingDriverRows } = await pool.query(
    `select id from public.profiles where role = 'driver' order by created_at asc limit 1`,
  );
  const reuseProfileId = existingDriverRows[0]?.id ?? null;
  const { data: existingDrivers } = await svc.auth.admin.listUsers();

  for (const d of DRIVERS) {
    let profileId;
    if (d.reuseDriverTest && reuseProfileId) {
      profileId = reuseProfileId;
    } else {
      const email = d.email;
      const found = (existingDrivers?.users ?? []).find((u) => u.email === email);
      if (found) {
        profileId = found.id;
      } else {
        const { data: created, error } = await svc.auth.admin.createUser({
          email,
          password: crypto.randomBytes(18).toString("base64url"),
          email_confirm: true,
          user_metadata: { full_name: d.name },
        });
        if (error) throw new Error(`create driver user ${email}: ${error.message}`);
        profileId = created.user.id;
      }
    }
    await pool.query(`update public.profiles set role = 'driver', full_name = $2, phone = $3 where id = $1`, [
      profileId,
      d.name,
      d.phone,
    ]);
    const { data: drv, error: drvErr } = await svc
      .from("drivers")
      .insert({ profile_id: profileId, full_name: d.name, phone: d.phone, vehicle_info: d.vehicle, active: true })
      .select("id")
      .single();
    if (drvErr) throw new Error(`insert driver ${d.name}: ${drvErr.message}`);
    driverIds[d.key] = drv.id;
    if (d.truck && truckByName[d.truck]) {
      await svc.from("trucks").update({ assigned_driver_id: drv.id }).eq("id", truckByName[d.truck]);
    }
    log(`        ${d.name}  ->  ${d.truck ?? "(no truck)"}  [driver ${drv.id.slice(0, 8)}]`);
  }

  // ---- 5. throwaway owner ------------------------------------------
  log("[5/7] Creating throwaway seed-admin owner…");
  {
    const { data, error } = await svc.auth.admin.createUser({
      email: SEED_ADMIN_EMAIL,
      password: SEED_ADMIN_PW,
      email_confirm: true,
      user_metadata: { full_name: "Seed Admin (temporary)" },
    });
    if (error) throw new Error(`create seed-admin: ${error.message}`);
    seedAdminId = data.user.id;
    await pool.query(`update public.profiles set role = 'owner', full_name = 'Seed Admin (temporary)' where id = $1`, [
      seedAdminId,
    ]);
  }
  const staff = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  {
    const { error } = await staff.auth.signInWithPassword({ email: SEED_ADMIN_EMAIL, password: SEED_ADMIN_PW });
    if (error) throw new Error(`seed-admin sign-in: ${error.message}`);
  }
  const srpc = async (fn, args) => {
    const { data, error } = await staff.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message} ${error.details ?? ""} ${error.hint ?? ""}`);
    return data;
  };

  // ---- 6. seed bookings ---------------------------------------------
  log("[6/7] Seeding 14 bookings through the real RPCs…");
  const usedUnits = new Set();
  const pickUnit = async (size) => {
    const { data } = await svc
      .from("dumpsters")
      .select("id, unit_number")
      .eq("size", size)
      .eq("status", "available")
      .order("unit_number");
    const u = (data ?? []).find((x) => !usedUnits.has(x.id));
    if (!u) throw new Error(`no free ${size} unit`);
    usedUnits.add(u.id);
    return u;
  };

  const results = [];
  for (const b of BOOKINGS) {
    const bookingId = await svc
      .rpc("create_booking", {
        p_size: b.size,
        p_delivery_date: FAR,
        p_delivery_address: `${b.street}, ${b.city}, ${b.state} ${b.zip}`,
        p_contact_name: b.name,
        p_rental_days: b.rentalDays ?? 5,
        p_placement_notes: b.notes || null,
        p_debris_type: b.debris || null,
        p_contact_email: b.email || null,
        p_contact_phone: b.phone || null,
        p_company_name: b.company || null,
        p_profile_id: null,
      })
      .then(({ data, error }) => {
        if (error) throw new Error(`create_booking #${b.ref}: ${error.message} ${error.hint ?? ""}`);
        return data;
      });

    const deliveryDate = ymd(b.deliveryOffset);
    const pickupDate =
      b.pickupOffset !== undefined
        ? ymd(b.pickupOffset)
        : ymd(b.deliveryOffset + (b.rentalDays ?? 5) - 1);

    // backdate to the real window BEFORE any unit is attached (no exclusion concern)
    await svc.from("bookings").update({ delivery_date: deliveryDate, pickup_date: pickupDate }).eq("id", bookingId);
    await svc.from("jobs").update({ scheduled_date: deliveryDate }).eq("booking_id", bookingId).eq("type", "delivery");

    const { data: jobs } = await svc.from("jobs").select("id, type").eq("booking_id", bookingId);
    const deliveryJob = jobs.find((j) => j.type === "delivery");
    const driverId = b.driver ? driverIds[b.driver] : null;

    let unit = null;
    const needsUnit = ["confirmed_routed", "active", "active_override", "pickup_routed", "pickup_unrouted", "overdue", "returned"].includes(
      b.lifecycle,
    );
    if (needsUnit) unit = await pickUnit(b.size);

    // ---- drive the lifecycle -------------------------------------------
    if (b.lifecycle === "confirmed") {
      // leave as confirmed
    } else if (b.lifecycle === "confirmed_routed") {
      await srpc("assign_job", { p_job_id: deliveryJob.id, p_driver_id: driverId, p_dumpster_id: unit.id, p_override: true });
      await srpc("set_route_order", { p_driver_id: driverId, p_date: deliveryDate, p_job_ids: [deliveryJob.id] });
    } else if (b.lifecycle === "active" || b.lifecycle === "active_override") {
      await srpc("assign_job", { p_job_id: deliveryJob.id, p_driver_id: driverId, p_dumpster_id: unit.id, p_override: true });
      await srpc("complete_job", { p_job_id: deliveryJob.id });
      await srpc("set_booking_docusign_status", { p_booking_id: bookingId, p_to: "signed" });
    } else if (b.lifecycle === "pickup_routed" || b.lifecycle === "pickup_unrouted") {
      const deliveryDriver = driverId ?? driverIds.marcus;
      await srpc("assign_job", { p_job_id: deliveryJob.id, p_driver_id: deliveryDriver, p_dumpster_id: unit.id, p_override: true });
      await srpc("complete_job", { p_job_id: deliveryJob.id });
      await srpc("set_booking_status", { p_booking_id: bookingId, p_to: "pickup_scheduled" });
      await svc.from("jobs").update({ scheduled_date: pickupDate }).eq("booking_id", bookingId).eq("type", "pickup");
      await srpc("set_booking_docusign_status", { p_booking_id: bookingId, p_to: "signed" });
      if (b.lifecycle === "pickup_routed") {
        const { data: pj } = await svc.from("jobs").select("id").eq("booking_id", bookingId).eq("type", "pickup").single();
        await srpc("assign_job", { p_job_id: pj.id, p_driver_id: driverId, p_dumpster_id: null, p_override: true });
        await srpc("set_route_order", { p_driver_id: driverId, p_date: pickupDate, p_job_ids: [pj.id] });
      }
    } else if (b.lifecycle === "overdue") {
      await srpc("assign_job", { p_job_id: deliveryJob.id, p_driver_id: driverId, p_dumpster_id: unit.id, p_override: true });
      await srpc("complete_job", { p_job_id: deliveryJob.id });
      await srpc("set_booking_docusign_status", { p_booking_id: bookingId, p_to: "signed" });
      // pickup_date already in the past -> the daily sweep flips it
      await svc.rpc("mark_overdue_bookings");
    } else if (b.lifecycle === "returned") {
      await srpc("assign_job", { p_job_id: deliveryJob.id, p_driver_id: driverId, p_dumpster_id: unit.id, p_override: true });
      await srpc("complete_job", { p_job_id: deliveryJob.id });
      await srpc("set_booking_status", { p_booking_id: bookingId, p_to: "pickup_scheduled" });
      const { data: pj } = await svc.from("jobs").select("id").eq("booking_id", bookingId).eq("type", "pickup").single();
      await svc.from("jobs").update({ scheduled_date: pickupDate }).eq("id", pj.id);
      await srpc("assign_job", { p_job_id: pj.id, p_driver_id: driverId, p_dumpster_id: null, p_override: true });
      await srpc("complete_job", { p_job_id: pj.id });
      await srpc("set_booking_docusign_status", { p_booking_id: bookingId, p_to: "signed" });
    }

    // ---- payments: synthetic invoice for everything delivered+ ---------
    if (b.lifecycle !== "confirmed" && b.lifecycle !== "confirmed_routed") {
      const { data: bk } = await svc.from("bookings").select("total").eq("id", bookingId).single();
      await svc.rpc("record_payment", {
        p_booking_id: bookingId,
        p_qb_charge_id: `seed-charge-${b.ref}`,
        p_qb_payment_id: `seed-pay-${b.ref}`,
        p_amount: Number(bk.total),
      });
      // most sync clean, one left pending, one forced to error — dashboard realism
      if (b.ref === 10) {
        // leave pending
      } else if (b.ref === 7) {
        await svc.from("invoices").update({ sync_status: "error", failure_reason: "QBO 400: customer sync mismatch (seed)" }).eq("booking_id", bookingId);
      } else {
        await svc.rpc("record_invoice_synced", { p_booking_id: bookingId, p_qb_invoice_id: `seed-inv-${b.ref}` });
      }
    }

    results.push({ ref: b.ref, bookingId, unit: unit?.unit_number ?? null });
    log(`        #${String(b.ref).padStart(2)} ${b.lifecycle.padEnd(16)} ${b.size} ${deliveryDate}->${pickupDate} ${unit ? "unit " + unit.unit_number : ""}`);
  }

  // one declined payment attempt (no surviving booking) — payment-health surface
  await svc.rpc("record_payment_attempt", {
    p_kind: "declined",
    p_qb_charge_id: null,
    p_qb_refund_id: null,
    p_amount: 349.05,
    p_contact_email: "would.be.customer@example.com",
    p_reason: "Card declined (insufficient funds)",
    p_context: { size: "20yd", delivery_date: ymd(3), source: "seed" },
  });

  // ---- portal demo login: link the 3 PORTAL_EMAIL bookings -------------
  log("      Linking portal demo customer…");
  const portalPw = crypto.randomBytes(15).toString("base64url");
  const { data: portalUser, error: portalErr } = await svc.auth.admin.createUser({
    email: PORTAL_EMAIL,
    password: portalPw,
    email_confirm: true,
    user_metadata: { full_name: "Rebecca Lund" },
  });
  if (portalErr && !/already/i.test(portalErr.message)) throw new Error(`portal user: ${portalErr.message}`);
  const portalId = portalUser?.user?.id
    ?? (await svc.auth.admin.listUsers()).data.users.find((u) => u.email === PORTAL_EMAIL)?.id;
  await svc.from("customers").update({ profile_id: portalId }).eq("email", PORTAL_EMAIL);

  // ---- 7. verify -----------------------------------------------------
  log("\n[7/7] Verification");
  const { data: deployed } = await svc
    .from("bookings")
    .select("delivery_address, delivery_lat, delivery_lng, dumpsters!inner(unit_number,status), status")
    .eq("dumpsters.status", "deployed")
    .not("status", "in", "(returned,cancelled)");
  log(`\n  Deployed units (map candidates): ${deployed?.length ?? 0}`);
  for (const d of deployed ?? []) log(`    ${d.dumpsters.unit_number}  ${d.delivery_address}  ${d.delivery_lat ? "(cached geo)" : "(geocodes on first map load)"}`);

  const today = ymd(0);
  const { data: todayJobs } = await svc
    .from("jobs")
    .select("type, status, drivers(full_name), bookings(delivery_address)")
    .eq("scheduled_date", today)
    .neq("status", "cancelled");
  log(`\n  Jobs scheduled for today (${today}): ${todayJobs?.length ?? 0}`);
  for (const j of todayJobs ?? []) log(`    ${j.type} — ${j.drivers?.full_name ?? "unassigned"} — ${j.bookings?.delivery_address}`);

  for (const [label, table] of [
    ["bookings", "bookings"], ["jobs", "jobs"], ["customers", "customers"],
    ["invoices", "invoices"], ["payment_attempts", "payment_attempts"],
    ["notifications_log", "notifications_log"], ["status_log", "status_log"],
  ]) {
    const { count } = await svc.from(table).select("id", { count: "exact", head: true });
    log(`  ${label.padEnd(20)} ${count}`);
  }
  const { data: byStatus } = await svc.from("bookings").select("status");
  const tally = {};
  for (const r of byStatus ?? []) tally[r.status] = (tally[r.status] ?? 0) + 1;
  log(`  bookings by status: ${JSON.stringify(tally)}`);

  // ---- delete the throwaway owner ----------------------------------
  log("\nDeleting throwaway seed-admin owner…");
  const { error: delErr } = await svc.auth.admin.deleteUser(seedAdminId);
  if (delErr) {
    log(`  ⚠️  FAILED to delete seed-admin (${seedAdminId}): ${delErr.message}`);
    log(`  Delete it manually in the Supabase dashboard → Authentication.`);
  } else {
    const gone = !(await svc.auth.admin.listUsers()).data.users.some((u) => u.id === seedAdminId);
    log(gone ? `  ✓ seed-admin deleted and confirmed gone (${SEED_ADMIN_EMAIL})` : `  ⚠️ delete reported ok but user still listed`);
  }

  await pool.end();
  log(`\n  Portal demo login:  ${PORTAL_EMAIL}  /  ${portalPw}`);
  log("\nDone.");
}

async function clearBucket(bucket) {
  // recurse one level — our paths are <job_id>/<file>
  const { data: top, error } = await svc.storage.from(bucket).list("", { limit: 1000 });
  if (error) {
    log(`        (bucket list failed: ${error.message} — skipping)`);
    return;
  }
  let removed = 0;
  for (const entry of top ?? []) {
    if (entry.id === null) {
      const { data: inner } = await svc.storage.from(bucket).list(entry.name, { limit: 1000 });
      const paths = (inner ?? []).map((f) => `${entry.name}/${f.name}`);
      if (paths.length) {
        await svc.storage.from(bucket).remove(paths);
        removed += paths.length;
      }
    } else {
      await svc.storage.from(bucket).remove([entry.name]);
      removed++;
    }
  }
  log(`        removed ${removed} object(s)`);
}

main().catch(async (e) => {
  console.error("\n❌ SEED FAILED:", e.message);
  if (seedAdminId) {
    console.error(`\n⚠️  seed-admin owner (${SEED_ADMIN_EMAIL}, id ${seedAdminId}) may still exist.`);
    console.error("   Attempting cleanup…");
    const { error } = await svc.auth.admin.deleteUser(seedAdminId).catch((x) => ({ error: x }));
    console.error(error ? `   cleanup failed: ${error.message} — delete it manually.` : "   cleanup ok.");
  }
  process.exit(1);
});
