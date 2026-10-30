// Rolled-back probe for supabase/migrations/20261029000000_yard_today.sql.
//
//   node scripts/probe-yard-today.mjs        (repo root; reads DATABASE_URL from .env.local)
//
// Everything runs in ONE transaction that is always rolled back (finally):
// the migration itself, a pinned clock, a throwaway staff account and the
// bookings it creates. Nothing persists. It checks:
//   - size_availability and mark_overdue_bookings keep prosecdef, proconfig,
//     ACL, owner, arguments and return type; the definition differs from the
//     live one by exactly the one swapped expression;
//   - yard_today() is the America/New_York day and no API role can call it;
//   - with the clock pinned to 11:30 PM EST Sun Nov 1 (UTC is already Nov 2):
//       as service_role (how the app calls them): size_availability says the
//       yard's tomorrow is open and its today is past; create_booking accepts
//       tomorrow and refuses today; mark_overdue_bookings marks only pickups
//       before the yard's today;
//       as an authenticated staff user: staff_create_booking accepts tomorrow
//       and refuses today;
//   - after ROLLBACK every attribute, md5 and row count matches the start.
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

const MIGRATION = "supabase/migrations/20261029000000_yard_today.sql";
const ZONE = "America/New_York";
const SA = "public.size_availability(dumpster_size,date,date,integer)";
const MO = "public.mark_overdue_bookings()";
const SWAPS = {
  [SA]: ["(days.day < current_date + 1) as is_past", "(days.day < public.yard_today() + 1) as is_past"],
  [MO]: ["and pickup_date < current_date", "and pickup_date < public.yard_today()"],
};
// Pinned clock: 11:30 PM EST Sun Nov 1 2026. UTC date Nov 2; the yard's Nov 1.
const PIN = "2026-11-02T04:30:00Z";
const PIN_TODAY = "2026-11-01";
const PIN_TOMORROW = "2026-11-02";
const PROBE_EMAIL = `yard-today-probe-${crypto.randomUUID().slice(0, 8)}@example.com`;

const url = fs.readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, "");
pg.types.setTypeParser(1082, (v) => v); // date stays 'YYYY-MM-DD'
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const q = async (sql, params) => (await c.query(sql, params)).rows;
let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
  if (!cond) failures++;
};
const yardDay = (d) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
};

async function attrs(sig) {
  return (await q(
    `select p.prosecdef as secdef, p.proconfig as config, p.proacl::text as acl, pg_get_userbyid(p.proowner) as owner,
            pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as result,
            p.provolatile as volatility, md5(pg_get_functiondef(p.oid)) as md5, pg_get_functiondef(p.oid) as def
       from pg_proc p where p.oid = $1::regprocedure`,
    [sig],
  ))[0];
}
async function snapshot() {
  await c.query("begin transaction read only");
  try {
    const s = { [SA]: await attrs(SA), [MO]: await attrs(MO) };
    s.yard_today_exists = (await q(`select to_regprocedure('public.yard_today(timestamptz)') is not null as e`))[0].e;
    s.counts = (await q(`select
      (select count(*)::int from public.bookings) as bookings,
      (select count(*)::int from public.jobs) as jobs,
      (select count(*)::int from public.status_log) as status_log,
      (select count(*)::int from public.customers) as customers,
      (select count(*)::int from public.profiles) as profiles,
      (select count(*)::int from auth.users) as auth_users,
      (select count(*)::int from auth.users where email like 'yard-today-probe-%') as probe_users`))[0];
    return s;
  } finally {
    await c.query("rollback");
  }
}
const KEYS = ["secdef", "config", "acl", "owner", "args", "result", "volatility"];
const pick = (a) => Object.fromEntries(KEYS.map((k) => [k, a[k]]));

/** Run fn inside a savepoint; return its value or the error, and undo it if it failed. */
async function attempt(fn) {
  await c.query("savepoint probe_attempt");
  try {
    const v = await fn();
    await c.query("release savepoint probe_attempt");
    return { ok: true, value: v };
  } catch (e) {
    await c.query("rollback to savepoint probe_attempt");
    return { ok: false, code: e.code, message: e.message };
  }
}
async function asRole(role, claims, fn) {
  await c.query(`set local role ${role}`);
  await q(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [
    JSON.stringify(claims), claims.sub ?? "",
  ]);
  try {
    return await fn();
  } finally {
    await c.query("reset role");
    await q(`select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)`);
  }
}
const bookingArgs = (size, date, name) => [size, date, "1 Probe St, Columbus, OH 43215", name, 5, null, null, PROBE_EMAIL, null, null];

await c.connect();
const before = await snapshot();
console.log("BEFORE", JSON.stringify({ size_availability_md5: before[SA].md5, mark_overdue_md5: before[MO].md5, yard_today_exists: before.yard_today_exists, counts: before.counts }));
if (before.yard_today_exists) console.log("NOTE  yard_today already exists: the migration looks applied; this run re-checks it.");
const migrationSql = fs.readFileSync(MIGRATION, "utf8");

try {
  await c.query("begin");
  await c.query(migrationSql);

  console.log("-- definitions after the migration (inside the transaction)");
  for (const sig of [SA, MO]) {
    const after = await attrs(sig);
    ok(`${sig}: security definer, config, ACL, owner, args, return type, volatility unchanged`,
      JSON.stringify(pick(after)) === JSON.stringify(pick(before[sig])), pick(after));
    const [from, to] = SWAPS[sig];
    const undone = crypto.createHash("md5").update(after.def.replace(to, from)).digest("hex");
    ok(`${sig}: differs from the live definition by exactly the one expression`,
      after.def.split(to).length - 1 === 1 && !after.def.includes("current_date") && (before.yard_today_exists || undone === before[sig].md5),
      { swapped_back_md5: undone, live_md5: before[sig].md5 });
  }

  console.log("-- yard_today()");
  const yt = (await q(`select p.prosecdef, p.proconfig, p.provolatile,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
      has_function_privilege('postgres', p.oid, 'EXECUTE') as postgres
    from pg_proc p where p.oid = 'public.yard_today(timestamptz)'::regprocedure`))[0];
  ok("yard_today: stable, invoker, pinned search_path; only its owner can execute",
    yt.provolatile === "s" && !yt.prosecdef && JSON.stringify(yt.proconfig) === '["search_path=public"]' &&
      !yt.anon && !yt.authenticated && !yt.service_role && yt.postgres, yt);
  const clocks = [
    ["2026-10-29T19:45:00Z", "2026-10-29"], ["2026-10-30T01:00:00Z", "2026-10-29"], ["2026-11-01T05:30:00Z", "2026-11-01"],
    ["2026-11-01T06:30:00Z", "2026-11-01"], ["2026-11-02T04:30:00Z", "2026-11-01"], ["2026-11-02T05:00:00Z", "2026-11-02"],
    ["2027-01-01T02:00:00Z", "2026-12-31"],
  ];
  const got = [];
  for (const [at] of clocks) got.push((await q(`select public.yard_today($1::timestamptz) as d`, [at]))[0].d);
  ok("yard_today(p_now) is the New York day, across the Nov 1 change and year end",
    got.every((d, i) => d === clocks[i][1]), Object.fromEntries(clocks.map(([at], i) => [at, got[i]])));
  const realToday = (await q(`select public.yard_today() as d`))[0].d;
  ok("yard_today() with the real clock equals the New York day computed in JS", realToday === yardDay(new Date()), { db: realToday, js: yardDay(new Date()) });
  for (const role of ["anon", "authenticated"]) {
    const r = await asRole(role, { role }, () => attempt(() => q(`select public.yard_today()`)));
    ok(`${role} cannot call yard_today directly (42501)`, !r.ok && r.code === "42501", r.ok ? "allowed" : r.code);
  }

  console.log("-- real clock, as service_role (how the app calls size_availability)");
  const realTomorrow = (await q(`select public.yard_today() + 1 as d`))[0].d;
  const real = await asRole("service_role", { role: "service_role" }, () =>
    q(`select day, is_past from public.size_availability('20yd'::dumpster_size, $1::date, $2::date, 5) order by day`, [realToday, realTomorrow]));
  ok("real clock: the yard's today is past, its tomorrow is not", real[0].is_past === true && real[1].is_past === false, real);

  console.log(`-- clock pinned to ${PIN} (11:30 PM EST Sun Nov 1; UTC is already Nov 2)`);
  await c.query(`create or replace function public.yard_today(p_now timestamptz default now())
    returns date language sql stable set search_path = public
    as $$ select (timestamptz '${PIN}' at time zone 'America/New_York')::date $$`);
  ok("pinned yard_today() is Nov 1", (await q(`select public.yard_today() as d`))[0].d === PIN_TODAY);

  // Sizes with a free unit on the yard's tomorrow (the probe books up to two).
  const sizes = (await q(`select unnest(enum_range(null::dumpster_size))::text as s`)).map((r) => r.s);
  const free = [];
  for (const s of sizes) {
    const [d] = await q(`select total - committed as free, blocked from public.size_availability($1::dumpster_size, $2::date, $2::date, 5)`, [s, PIN_TOMORROW]);
    for (let i = 0; i < Math.max(0, d.blocked ? 0 : d.free); i++) free.push(s);
  }
  ok("found two free units on Nov 2 for the booking checks", free.length >= 2, free.slice(0, 4));
  const [sizeA, sizeB] = free;

  const sa = await asRole("service_role", { role: "service_role" }, () =>
    q(`select day, is_past from public.size_availability($1::dumpster_size, $2::date, $3::date, 5) order by day`, [sizeA, PIN_TODAY, PIN_TOMORROW]));
  ok("service_role size_availability: Nov 1 (yard today) past, Nov 2 (yard tomorrow) open", sa[0].is_past === true && sa[1].is_past === false, sa);

  const placeholders = Array.from({ length: 10 }, (_, i) => `$${i + 1}`).join(", ");
  const cbOk = await asRole("service_role", { role: "service_role" }, () =>
    attempt(() => q(`select public.create_booking(${placeholders}) as id`, bookingArgs(sizeA, PIN_TOMORROW, "PROBE service"))));
  ok("service_role create_booking accepts the yard's tomorrow (Nov 2)", cbOk.ok && !!cbOk.value[0].id, cbOk.ok ? "booked" : cbOk.message);
  const cbPast = await asRole("service_role", { role: "service_role" }, () =>
    attempt(() => q(`select public.create_booking(${placeholders}) as id`, bookingArgs(sizeA, PIN_TODAY, "PROBE service"))));
  ok("service_role create_booking refuses the yard's today (Nov 1)", !cbPast.ok && /tomorrow or later/.test(cbPast.message), cbPast.ok ? "booked" : cbPast.message);

  console.log("-- throwaway staff user (exists only inside this transaction)");
  const [{ id: staffId }] = await q(`insert into auth.users (id, aud, role, email) values (gen_random_uuid(), 'authenticated', 'authenticated', $1) returning id`, [PROBE_EMAIL]);
  // handle_new_user made a 'customer' profile. The role guard is BEFORE UPDATE,
  // so the fixture re-creates the profile as staff instead of updating it.
  await q(`delete from public.profiles where id = $1`, [staffId]);
  await q(`insert into public.profiles (id, role, full_name) values ($1, 'staff', 'Yard-today probe (throwaway)')`, [staffId]);
  const claims = { sub: staffId, role: "authenticated", email: PROBE_EMAIL };
  const isStaff = await asRole("authenticated", claims, () => q(`select public.is_staff() as s, auth.uid()::text as uid`));
  ok("the throwaway user is staff inside its own session", isStaff[0].s === true && isStaff[0].uid === staffId, isStaff[0]);

  const placeholders12 = Array.from({ length: 12 }, (_, i) => `$${i + 1}`).join(", ");
  const staffArgs = (date) => [...bookingArgs(sizeB, date, "PROBE staff"), false, null];
  const sbOk = await asRole("authenticated", claims, () =>
    attempt(() => q(`select public.staff_create_booking(${placeholders12}) as id`, staffArgs(PIN_TOMORROW))));
  ok("authenticated staff staff_create_booking accepts the yard's tomorrow (Nov 2)", sbOk.ok && !!sbOk.value[0].id, sbOk.ok ? "booked" : sbOk.message);
  if (sbOk.ok) {
    const [b] = await q(`select source, created_by::text, delivery_date from public.bookings where id = $1`, [sbOk.value[0].id]);
    ok("  ...recorded as a staff booking by that user", b.source === "staff" && b.created_by === staffId && b.delivery_date === PIN_TOMORROW, b);
  }
  const sbPast = await asRole("authenticated", claims, () =>
    attempt(() => q(`select public.staff_create_booking(${placeholders12}) as id`, staffArgs(PIN_TODAY))));
  ok("authenticated staff staff_create_booking refuses the yard's today (Nov 1)", !sbPast.ok && /tomorrow or later/.test(sbPast.message), sbPast.ok ? "booked" : sbPast.message);

  console.log("-- mark_overdue_bookings with the pinned clock, as service_role (how the daily cron calls it)");
  // Move the two probe bookings back so one pickup was due before the yard's
  // today (Oct 31: overdue) and one is due ON it (Nov 1: not overdue yet;
  // current_date, the UTC Nov 2, would have called it overdue).
  const probeIds = { overdue: cbOk.ok ? cbOk.value[0].id : null, dueToday: sbOk.ok ? sbOk.value[0].id : null };
  const moved = await attempt(async () => {
    await q(`update public.bookings set status = 'active', delivery_date = '2026-10-26', pickup_date = '2026-10-31' where id = $1`, [probeIds.overdue]);
    await q(`update public.bookings set status = 'active', delivery_date = '2026-10-27', pickup_date = '2026-11-01' where id = $1`, [probeIds.dueToday]);
  });
  ok("probe bookings set to active with pickups Oct 31 and Nov 1", moved.ok && !!probeIds.overdue && !!probeIds.dueToday, moved.ok ? "ok" : moved.message);
  const expected = (await q(`select id::text from public.bookings
      where status in ('active','pickup_scheduled') and pickup_date is not null and pickup_date < $1::date order by id`, [PIN_TODAY])).map((r) => r.id);
  const marked = (await asRole("service_role", { role: "service_role" }, () => q(`select public.mark_overdue_bookings()::text as id`))).map((r) => r.id).sort();
  ok("mark_overdue_bookings marks exactly the pickups before the yard's today",
    JSON.stringify(marked) === JSON.stringify(expected), { marked: marked.length, expected: expected.length });
  ok("  ...the Oct 31 pickup is marked overdue", marked.includes(probeIds.overdue));
  ok("  ...the Nov 1 pickup (due on the yard's today) is not", !marked.includes(probeIds.dueToday));
} finally {
  await c.query("rollback");
}

const after = await snapshot();
console.log("AFTER ROLLBACK", JSON.stringify({ size_availability_md5: after[SA].md5, mark_overdue_md5: after[MO].md5, yard_today_exists: after.yard_today_exists, counts: after.counts }));
for (const sig of [SA, MO]) {
  ok(`${sig}: md5, security definer, config and ACL identical before and after`,
    after[sig].md5 === before[sig].md5 && JSON.stringify(pick(after[sig])) === JSON.stringify(pick(before[sig])));
}
ok("yard_today exists after exactly as before", after.yard_today_exists === before.yard_today_exists);
ok("row counts identical before and after; no probe user left", JSON.stringify(after.counts) === JSON.stringify(before.counts) && after.counts.probe_users === 0);
await c.end();
console.log(failures ? `\n${failures} FAILED (rolled back)` : "\nALL PASS (rolled back)");
process.exit(failures ? 1 : 0);
