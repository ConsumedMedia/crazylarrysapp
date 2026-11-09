// Rolled-back probe for supabase/migrations/20261109010000_driver_access_requires_active.sql.
//
//   node --use-system-ca scripts/probe-driver-active.mjs     (repo root; reads DATABASE_URL from .env.local)
//
// Everything runs in ONE transaction that is always rolled back (finally): the
// migration itself, two throwaway drivers with their own customer, unit,
// booking, job, truck, photo row and notification row, and every write tried
// below. Real rows are only READ (as role authenticated with real claims).
// Prints ids shortened, never emails or phone numbers.
//
// Safe to re-run after the migration is applied: "before" is then already the
// new rule, and the probe says so.
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

const MIGRATION = "supabase/migrations/20261109010000_driver_access_requires_active.sql";
const VERSION = "20261109010000";
const LARRY = "923ed11f-196b-4939-9639-f576b4d88c87"; // owner (staff), has an active driver row with no jobs
const MARCUS = "a1010b9b-2268-49a5-9118-0ef82ea5442a"; // active test driver with real jobs
const INACTIVE_SEED = ["63055770-1dd4-4316-a1fc-11decccffe34", "457ad928-d96b-409f-a1da-22c0179d0da4"]; // driver rows 1007f111, 59688564
const TAG = crypto.randomUUID().slice(0, 8);
const FIXTURE_LIKE = "driver-active-probe-%";
const mail = (who) => `driver-active-probe-${TAG}-${who}@example.com`;
const short = (id) => String(id).slice(0, 8);

const POLICIES = [
  ["public", "jobs", "jobs: driver reads assigned jobs"],
  ["public", "bookings", "bookings: driver reads bookings on their jobs"],
  ["public", "job_photos", "job_photos: driver reads own job photos"],
  ["public", "job_photos", "job_photos: driver inserts own job photos"],
  ["public", "trucks", "trucks: driver reads own assigned truck"],
  ["public", "notifications_log", "notifications_log: driver reads own"],
  ["storage", "objects", "job-photos: driver uploads own job photos"],
];
// Must stay exactly as they are.
const UNCHANGED_POLICIES = [
  ["public", "drivers", "drivers: driver reads own record"],
  ["public", "drivers", "drivers: staff full access"],
  ["public", "jobs", "jobs: staff full access"],
  ["public", "bookings", "bookings: staff full access"],
  ["public", "customers", "customers: driver reads customers on their assigned jobs"],
  ["public", "customers", "customers: staff full access"],
  ["public", "dumpsters", "dumpsters: driver reads units on their assigned jobs"],
  ["public", "dumpsters", "dumpsters: staff full access"],
  ["public", "job_photos", "job_photos: staff full access"],
  ["public", "trucks", "trucks: staff full access"],
  ["public", "notifications_log", "notifications_log: staff full access"],
  ["storage", "objects", "job-photos: staff full access"],
];
const FUNCTIONS = ["public.driver_can_see_customer(uuid)", "public.driver_can_see_dumpster(uuid)", "public.complete_job(uuid)"];
const UNCHANGED_FUNCTIONS = [
  "public.is_staff()",
  "public.current_user_role()",
  "public.check_job_assignment(uuid,uuid)",
  "public.assign_job(uuid,uuid,uuid,boolean)",
  "public.list_staff_users()",
  "public.open_jobs_for_profile(uuid)",
  "public.remove_staff_user(uuid)",
];
const COUNTED_TABLES = ["drivers", "profiles", "customers", "dumpsters", "bookings", "jobs", "trucks", "job_photos", "notifications_log", "status_log"];

const url = fs.readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, "");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const q = async (sql, params) => (await c.query(sql, params)).rows;
let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
  if (!cond) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Savepoints get unique names and are released after a rollback, so nested
// undone() calls each return to their own starting point.
let spSeq = 0;
async function attempt(fn) {
  const sp = `probe_attempt_${++spSeq}`;
  await c.query(`savepoint ${sp}`);
  try {
    const value = await fn();
    await c.query(`release savepoint ${sp}`);
    return { ok: true, value };
  } catch (e) {
    await c.query(`rollback to savepoint ${sp}`);
    await c.query(`release savepoint ${sp}`);
    return { ok: false, code: e.code, message: e.message };
  }
}
/** Runs fn, then undoes everything it did. */
async function undone(fn) {
  const sp = `probe_undo_${++spSeq}`;
  await c.query(`savepoint ${sp}`);
  try {
    return await fn();
  } finally {
    await c.query(`rollback to savepoint ${sp}`);
    await c.query(`release savepoint ${sp}`);
  }
}
async function authed(id, fn) {
  await c.query("set local role authenticated");
  await q(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [
    JSON.stringify({ sub: id, role: "authenticated", aud: "authenticated" }),
    id,
  ]);
  try {
    return await fn();
  } finally {
    await c.query("reset role");
    await q(`select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)`);
  }
}
const refused = (r) => !r.ok && r.code === "42501";

const policyRow = async ([schema, table, name]) =>
  (
    await q(
      `select permissive, roles::text as roles, cmd, qual, with_check from pg_policies where schemaname = $1 and tablename = $2 and policyname = $3`,
      [schema, table, name],
    )
  )[0] ?? null;
const fnRow = async (sig) =>
  (
    await q(
      `select md5(pg_get_functiondef(p.oid)) as md5, pg_get_functiondef(p.oid) as def, p.proacl::text as acl, p.prosecdef as definer,
              p.proconfig::text as config, pg_get_userbyid(p.proowner) as owner, p.provolatile as volatility,
              pg_get_function_result(p.oid) as result
         from pg_proc p where p.oid = to_regprocedure($1)`,
      [sig],
    )
  )[0] ?? null;
const lf = (s) => (s == null ? s : s.replace(/\r\n/g, "\n"));

async function snapshot() {
  await c.query("begin transaction read only");
  try {
    const policies = {};
    for (const p of [...POLICIES, ...UNCHANGED_POLICIES]) policies[p[2]] = await policyRow(p);
    const functions = {};
    for (const sig of [...FUNCTIONS, ...UNCHANGED_FUNCTIONS]) functions[sig] = await fnRow(sig);
    const counts = {};
    for (const t of COUNTED_TABLES) counts[t] = (await q(`select count(*)::int as n from public.${t}`))[0].n;
    counts.authUsers = (await q(`select count(*)::int as n from auth.users`))[0].n;
    counts.jobPhotoObjects = (await q(`select count(*)::int as n from storage.objects where bucket_id = 'job-photos'`))[0].n;
    return {
      policies,
      functions,
      counts,
      drivers: (await q(`select md5(string_agg(id::text || active::text || profile_id::text, ',' order by id)) as m from public.drivers`))[0].m,
      jobs: (await q(`select md5(string_agg(id::text || status::text || coalesce(driver_id::text, ''), ',' order by id)) as m from public.jobs`))[0].m,
      bookings: (await q(`select md5(string_agg(id::text || status::text || coalesce(dumpster_id::text, ''), ',' order by id)) as m from public.bookings`))[0].m,
      fixtures: (await q(`select count(*)::int as n from auth.users where email like $1`, [FIXTURE_LIKE]))[0].n,
      migrations: (await q(`select count(*)::int as n from supabase_migrations.schema_migrations`))[0].n,
      applied: (await q(`select count(*)::int as n from supabase_migrations.schema_migrations where version = $1`, [VERSION]))[0].n === 1,
    };
  } finally {
    await c.query("rollback");
  }
}

/** What one account can read of the real data, by table (role authenticated). */
const realView = (id) =>
  authed(id, async () => (await q(`select
      (select count(*) from public.jobs)::int as jobs,
      (select count(*) from public.bookings)::int as bookings,
      (select count(*) from public.customers)::int as customers,
      (select count(*) from public.dumpsters)::int as dumpsters,
      (select count(*) from public.trucks)::int as trucks,
      (select count(*) from public.job_photos)::int as photos,
      (select count(*) from public.notifications_log)::int as notifications,
      (select count(*) from public.drivers where profile_id = auth.uid())::int as own_driver_row`))[0]);

await c.connect();
const before = await snapshot();
const alreadyApplied = before.applied;
try {
  await c.query("begin");
  await c.query("set local lock_timeout = '5s'");
  console.log(`-- ${alreadyApplied ? "the migration is ALREADY applied, so before = after" : "the migration is not applied yet"}`);

  console.log("-- real data, read as role authenticated BEFORE the migration (this transaction)");
  const realBefore = {
    marcus: await realView(MARCUS),
    larry: await realView(LARRY),
    inactive: [await realView(INACTIVE_SEED[0]), await realView(INACTIVE_SEED[1])],
  };
  console.log("   Marcus (active driver):", JSON.stringify(realBefore.marcus));
  console.log("   Larry (owner):", JSON.stringify(realBefore.larry));
  INACTIVE_SEED.forEach((id, i) => console.log(`   inactive seed driver ${short(id)}:`, JSON.stringify(realBefore.inactive[i])));
  const inactiveFlags = await q(`select profile_id::text as p, active from public.drivers where profile_id = any($1::uuid[]) order by 1`, [INACTIVE_SEED]);
  ok("both seed drivers are inactive today", inactiveFlags.length === 2 && inactiveFlags.every((r) => !r.active), inactiveFlags.map((r) => [short(r.p), r.active]));
  const openSeed = await q(
    `select count(*)::int as n from public.jobs j join public.drivers d on d.id = j.driver_id where d.profile_id = any($1::uuid[]) and j.status = 'assigned'`,
    [INACTIVE_SEED],
  );
  ok("the inactive seed drivers have 0 assigned jobs", openSeed[0].n === 0, openSeed[0].n);

  console.log("-- apply the migration inside this transaction");
  await c.query(fs.readFileSync(MIGRATION, "utf8"));

  console.log("-- policies: only the active check added");
  for (const p of POLICIES) {
    const b = before.policies[p[2]];
    const a = await policyRow(p);
    const expr = (r) => lf(r?.qual ?? r?.with_check ?? "");
    const field = b?.qual ? "qual" : "with_check";
    const occurrences = (expr(a).match(/d\.active/g) ?? []).length;
    ok(`${p[2]}: same command, roles and permissive`, !!a && !!b && a.cmd === b.cmd && a.roles === b.roles && a.permissive === b.permissive, a && [a.cmd, a.roles]);
    ok(`${p[2]}: ${field} has "d.active" exactly once`, occurrences === 1, occurrences);
    ok(
      `${p[2]}: ${alreadyApplied ? "unchanged by re-applying" : "identical to live apart from the added d.active"}`,
      alreadyApplied ? expr(a) === expr(b) : expr(a).replace(" AND d.active", "") === expr(b) && expr(a) !== expr(b),
      alreadyApplied ? undefined : expr(a),
    );
    ok(`${p[2]}: the other expression is untouched`, (field === "qual" ? a.with_check : a.qual) === (field === "qual" ? b.with_check : b.qual));
  }
  for (const p of UNCHANGED_POLICIES) ok(`${p[2]}: unchanged`, same(await policyRow(p), before.policies[p[2]]));
  const ownRecord = await policyRow(UNCHANGED_POLICIES[0]);
  ok("drivers: driver reads own record still has no active check", ownRecord?.qual === "(profile_id = auth.uid())", ownRecord?.qual);

  console.log("-- functions: only the active check added; md5 changes, nothing else does");
  for (const sig of FUNCTIONS) {
    const b = before.functions[sig];
    const a = await fnRow(sig);
    const bd = lf(b.def);
    const ad = lf(a.def);
    ok(
      `${sig}: ${alreadyApplied ? "body unchanged by re-applying" : "body identical to live apart from the added d.active"}`,
      alreadyApplied ? ad === bd : ad.replace(/(\n\s+| )and d\.active(?=\n)/, "") === bd && ad !== bd,
    );
    ok(`${sig}: "d.active" exactly once`, (ad.match(/d\.active/g) ?? []).length === 1);
    ok(`${sig}: md5 ${alreadyApplied ? "same" : "changed"}`, alreadyApplied ? a.md5 === b.md5 : a.md5 !== b.md5, [b.md5.slice(0, 8), a.md5.slice(0, 8)]);
    ok(`${sig}: ACL identical`, a.acl === b.acl, a.acl);
    ok(`${sig}: prosecdef identical (definer)`, a.definer === b.definer && a.definer === true);
    ok(`${sig}: proconfig identical`, a.config === b.config && a.config === "{search_path=public}", a.config);
    ok(`${sig}: owner, volatility and result type identical`, a.owner === b.owner && a.volatility === b.volatility && a.result === b.result, [a.owner, a.volatility, a.result]);
  }
  for (const sig of UNCHANGED_FUNCTIONS) ok(`${sig}: unchanged`, same(await fnRow(sig), before.functions[sig]));

  console.log("-- real data AFTER the migration (same transaction, read only)");
  const realAfter = {
    marcus: await realView(MARCUS),
    larry: await realView(LARRY),
    inactive: [await realView(INACTIVE_SEED[0]), await realView(INACTIVE_SEED[1])],
  };
  ok("Marcus (active) reads exactly what he read before", same(realAfter.marcus, realBefore.marcus), realAfter.marcus);
  ok("Larry (owner) reads exactly what he read before", same(realAfter.larry, realBefore.larry), realAfter.larry);
  INACTIVE_SEED.forEach((id, i) => {
    const v = realAfter.inactive[i];
    console.log(`   inactive seed driver ${short(id)} now:`, JSON.stringify(v));
    ok(
      `inactive seed driver ${short(id)}: no jobs, bookings, customers, units, trucks, photos or notifications; own drivers row still 1`,
      v.jobs === 0 && v.bookings === 0 && v.customers === 0 && v.dumpsters === 0 && v.trucks === 0 && v.photos === 0 && v.notifications === 0 && v.own_driver_row === 1,
    );
  });

  // The live jobs policy without the active check (for the isolation step).
  const JOBS_QUAL_WITHOUT_ACTIVE = lf(before.policies[POLICIES[0][2]].qual).replace(" AND d.active", "");

  console.log("-- throwaway fixtures: drivers A and B, each with a customer, unit, booking, job, truck, photo and notification");
  const size = (await q(`select (enum_range(null::public.dumpster_size))[1]::text as s`))[0].s;
  async function makeDriver(who) {
    const [{ id }] = await q(
      `insert into auth.users (id, aud, role, email, email_confirmed_at) values (gen_random_uuid(), 'authenticated', 'authenticated', $1, now()) returning id::text`,
      [mail(who)],
    );
    await q(`delete from public.profiles where id = $1`, [id]);
    await q(`insert into public.profiles (id, role, full_name) values ($1, 'driver', $2)`, [id, `Driver active probe ${who}`]);
    const [{ id: driverId }] = await q(`insert into public.drivers (profile_id, full_name, active) values ($1, $2, true) returning id::text`, [id, `Driver active probe ${who}`]);
    const [{ id: customer }] = await q(`insert into public.customers (full_name) values ($1) returning id::text`, [`Driver active probe customer ${who}`]);
    const [{ id: dumpster }] = await q(`insert into public.dumpsters (unit_number, size) values ($1, $2::public.dumpster_size) returning id::text`, [`probe-${TAG}-${who}`, size]);
    const [{ id: booking }] = await q(
      `insert into public.bookings (customer_id, dumpster_id, size_requested, delivery_address, delivery_date, pickup_date, status, source)
       values ($1, $2, $3::public.dumpster_size, 'Driver active probe', '2099-01-04', '2099-01-11', 'confirmed', 'staff') returning id::text`,
      [customer, dumpster, size],
    );
    const [{ id: job }] = await q(
      `insert into public.jobs (booking_id, type, driver_id, scheduled_date, status) values ($1, 'delivery', $2, '2099-01-04', 'assigned') returning id::text`,
      [booking, driverId],
    );
    const [{ id: truck }] = await q(
      `insert into public.trucks (year, make, model, nickname, assigned_driver_id, allowed_sizes)
       values (2020, 'Probe', 'Probe', $1, $2, array[$3::public.dumpster_size]) returning id::text`,
      [`probe-${TAG}-${who}`, driverId, size],
    );
    const [{ id: photo }] = await q(`insert into public.job_photos (job_id, storage_path, uploaded_by) values ($1, $2, $3) returning id::text`, [job, `${job}/fixture.jpg`, id]);
    // A log row only: nothing reads uncommitted rows, so nothing is sent.
    const [{ id: notification }] = await q(
      `insert into public.notifications_log (driver_id, booking_id, type, channel, recipient, failure_category)
       values ($1, $2, (enum_range(null::public.notification_type))[1], (enum_range(null::public.notification_channel))[1], 'driver-active-probe', 'disabled')
       returning id::text`,
      [driverId, booking],
    );
    return { id, driverId, customer, dumpster, booking, job, truck, photo, notification };
  }
  await c.query("savepoint fixtures");
  let A, B;
  try {
    A = await makeDriver("a");
    B = await makeDriver("b");
  } catch (e) {
    await c.query("rollback to savepoint fixtures");
    throw e;
  }

  /** Which of one fixture set's rows the account can read. 1 = visible, 0 = not. */
  const rowsOf = (f) =>
    q(
      `select (select count(*) from public.jobs where id = $1)::int as job,
              (select count(*) from public.bookings where id = $2)::int as booking,
              (select count(*) from public.customers where id = $3)::int as customer,
              (select count(*) from public.dumpsters where id = $4)::int as dumpster,
              (select count(*) from public.trucks where id = $5)::int as truck,
              (select count(*) from public.job_photos where id = $6)::int as photo,
              (select count(*) from public.notifications_log where id = $7)::int as notification`,
      [f.job, f.booking, f.customer, f.dumpster, f.truck, f.photo, f.notification],
    ).then((r) => r[0]);
  const ALL = { job: 1, booking: 1, customer: 1, dumpster: 1, truck: 1, photo: 1, notification: 1 };
  const NONE = { job: 0, booking: 0, customer: 0, dumpster: 0, truck: 0, photo: 0, notification: 0 };
  const view = (who) => authed(who, async () => ({ own: await rowsOf(who === A.id ? A : B), other: await rowsOf(who === A.id ? B : A) }));
  const larryView = () => authed(LARRY, async () => ({ a: await rowsOf(A), b: await rowsOf(B) }));
  const ownDriverRow = (who) => authed(who, async () => (await q(`select count(*)::int as n from public.drivers where profile_id = auth.uid()`))[0].n);
  const insertPhoto = (who, f) => () =>
    attempt(() => q(`insert into public.job_photos (job_id, storage_path, uploaded_by) values ($1, $2, $3)`, [f.job, `${f.job}/probe-insert.jpg`, who]));
  const upload = (who, f) => () =>
    attempt(() => q(`insert into storage.objects (bucket_id, name, owner_id) values ('job-photos', $1, $2)`, [`${f.job}/probe-upload.jpg`, who]));
  const complete = (f) => () => attempt(() => q(`select (public.complete_job($1)).status::text as status`, [f.job]));
  const run = (who, step) => undone(() => authed(who, step));

  console.log("-- A active");
  const activeA = await view(A.id);
  ok("A reads its own job, booking, customer, unit, truck, photo and notification", same(activeA.own, ALL), activeA.own);
  ok("A reads none of B's rows", same(activeA.other, NONE), activeA.other);
  ok("A reads its own drivers row", (await ownDriverRow(A.id)) === 1);
  ok("A inserts a photo row for its own job", (await run(A.id, insertPhoto(A.id, A))).ok);
  ok("A uploads to job-photos/<own job>/", (await run(A.id, upload(A.id, A))).ok);
  const doneA = await run(A.id, complete(A));
  ok("A completes its own job", doneA.ok && doneA.value[0].status === "completed", doneA.ok ? doneA.value[0] : doneA.message);
  ok("A can't insert a photo row for B's job", refused(await run(A.id, insertPhoto(A.id, B))));
  ok("A can't upload to B's job folder", refused(await run(A.id, upload(A.id, B))));
  ok("A can't complete B's job", refused(await run(A.id, complete(B))));
  const larryActive = await larryView();
  ok("Larry (staff) reads all of A's and B's rows", same(larryActive, { a: ALL, b: ALL }), larryActive);

  console.log("-- A set inactive inside this transaction");
  const inactive = await undone(async () => {
    await q(`update public.drivers set active = false where id = $1`, [A.driverId]);
    const r = {
      view: await view(A.id),
      ownRow: await ownDriverRow(A.id),
      photo: await run(A.id, insertPhoto(A.id, A)),
      upload: await run(A.id, upload(A.id, A)),
      complete: await run(A.id, complete(A)),
      b: await view(B.id),
      larry: await larryView(),
      larryCompletes: await run(LARRY, complete(A)),
    };
    // The bookings, job_photos and storage policies join jobs, which is itself
    // under RLS, so the jobs policy's own active check would hide their rows
    // anyway. To prove each one refuses on its own, put the OLD jobs policy
    // (no active check) back for a moment, inside a savepoint.
    r.isolated = await undone(async () => {
      await q(`alter policy "jobs: driver reads assigned jobs" on public.jobs using (${JOBS_QUAL_WITHOUT_ACTIVE})`);
      return {
        view: await view(A.id),
        photo: await run(A.id, insertPhoto(A.id, A)),
        upload: await run(A.id, upload(A.id, A)),
      };
    });
    console.log("-- A set active again");
    await q(`update public.drivers set active = true where id = $1`, [A.driverId]);
    r.restored = {
      view: await view(A.id),
      photo: await run(A.id, insertPhoto(A.id, A)),
      upload: await run(A.id, upload(A.id, A)),
      complete: await run(A.id, complete(A)),
    };
    return r;
  });
  ok("inactive A reads zero of its own rows", same(inactive.view.own, NONE), inactive.view.own);
  ok("inactive A reads zero of B's rows", same(inactive.view.other, NONE), inactive.view.other);
  ok("inactive A still reads its own drivers row (inactive banner)", inactive.ownRow === 1, inactive.ownRow);
  ok("inactive A: photo row insert -> 42501", refused(inactive.photo), inactive.photo.code ?? "allowed");
  ok("inactive A: job-photos upload -> 42501", refused(inactive.upload), inactive.upload.code ?? "allowed");
  ok("inactive A: complete_job -> 42501", refused(inactive.complete), inactive.complete.code ?? "allowed");
  ok("B (active) still reads all of its own rows and none of A's", same(inactive.b, { own: ALL, other: NONE }), inactive.b);
  ok("Larry (staff) reads the same rows as before", same(inactive.larry, larryActive), inactive.larry);
  ok("Larry (staff) can still complete A's job", inactive.larryCompletes.ok, inactive.larryCompletes.message);
  const iso = inactive.isolated;
  ok("isolated (old jobs policy back): inactive A sees its job again, so jobs is the only thing that changed", iso.view.own.job === 1, iso.view.own);
  ok("isolated: the bookings policy alone hides A's booking", iso.view.own.booking === 0);
  ok("isolated: the job_photos read policy alone hides A's photo", iso.view.own.photo === 0);
  ok("isolated: the job_photos insert policy alone refuses (42501)", refused(iso.photo), iso.photo.code ?? "allowed");
  ok("isolated: the storage upload policy alone refuses (42501)", refused(iso.upload), iso.upload.code ?? "allowed");
  ok("isolated: customer, unit, truck and notification still hidden", iso.view.own.customer + iso.view.own.dumpster + iso.view.own.truck + iso.view.own.notification === 0);
  ok("active again: A reads all of its own rows", same(inactive.restored.view.own, ALL), inactive.restored.view.own);
  ok("active again: A still reads none of B's rows", same(inactive.restored.view.other, NONE));
  ok("active again: photo row insert works", inactive.restored.photo.ok, inactive.restored.photo.message);
  ok("active again: upload works", inactive.restored.upload.ok, inactive.restored.upload.message);
  ok("active again: complete_job works", inactive.restored.complete.ok, inactive.restored.complete.message);

  console.log("-- after the savepoint: A is active again, fixtures intact");
  ok("A is active", (await q(`select active from public.drivers where id = $1`, [A.driverId]))[0].active === true);
  ok("A's job is still assigned (completions were undone)", (await q(`select status::text as s from public.jobs where id = $1`, [A.job]))[0].s === "assigned");
  ok("Larry reads the same rows as at the start", same(await larryView(), larryActive));
} finally {
  await c.query("rollback").catch(() => {});
}

console.log("-- after ROLLBACK");
const end = await snapshot();
for (const name of Object.keys(before.policies)) ok(`policy back to the start: ${name}`, same(end.policies[name], before.policies[name]));
for (const sig of Object.keys(before.functions)) {
  const b = before.functions[sig];
  const e = end.functions[sig];
  ok(`function back to the start (md5, ACL, prosecdef, proconfig, owner): ${sig}`, !!e && e.md5 === b.md5 && e.acl === b.acl && e.definer === b.definer && e.config === b.config && e.owner === b.owner);
}
ok("row counts identical in every table touched", same(end.counts, before.counts), end.counts);
ok("drivers (id, active, profile) identical", end.drivers === before.drivers);
ok("jobs (id, status, driver) identical", end.jobs === before.jobs);
ok("bookings (id, status, unit) identical", end.bookings === before.bookings);
ok("no fixture accounts left", end.fixtures === 0, end.fixtures);
ok("migration history untouched", end.migrations === before.migrations && end.applied === before.applied, end.migrations);
await c.end();

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED, EVERYTHING ROLLED BACK");
process.exit(failures ? 1 : 0);
