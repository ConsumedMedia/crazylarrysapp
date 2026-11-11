// Rolled-back probe for supabase/migrations/20261111000000_booking_cutoff.sql.
//
//   node --use-system-ca scripts/probe-booking-cutoff.mjs     (repo root; reads DATABASE_URL from .env.local)
//
// Everything runs in ONE transaction that is always rolled back (finally): the
// migration, the settings changes, a throwaway staff account, real
// agreement_sessions rows, and every booking, customer, job and pay link the
// scenarios create. Each scenario also runs in its own savepoint, undone at
// once, so they don't use up each other's capacity.
//
// The clock is faked by replacing public._booking_clock() inside the
// transaction (the migration's one indirection for this). The floor function
// itself takes p_now, so the clock-change cases call it directly. Booking
// scenarios use the REAL yard day, so the core's own "tomorrow or later" check
// (which reads the real clock) agrees with the faked time of day.
//
// Pins: md5 (carriage returns removed) and ACL of every function the migration
// rebuilds or must leave alone, before and after. Counts and a fingerprint of
// real bookings are checked inside the transaction and after the rollback.
// Prints ids shortened, never names, emails or phone numbers.
//
// PROBE_MIGRATION overrides the file (mutation runs only).
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

const MIGRATION = process.env.PROBE_MIGRATION || "supabase/migrations/20261111000000_booking_cutoff.sql";
const TAG = crypto.randomUUID().slice(0, 8);
const SIGNER = `cutoff-probe-${TAG}@example.com`;
const short = (id) => String(id).slice(0, 8);

const REBUILT = {
  "public.create_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,uuid,boolean,uuid)": "96232bfd70e9c467ba2d3b794405bcbc",
  "public.staff_create_pay_link_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,boolean,uuid,text)": "140c6369182c6cada3dd689618bf09d8",
};
const UNTOUCHED = {
  "public._create_booking_core(dumpster_size,date,text,text,integer,text,text,text,text,text,uuid,boolean,uuid,text,uuid,uuid)": "e8245ce0504d55f53bad223cba209d60",
  "public.staff_create_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,boolean,uuid)": "f646b99e9ce92916d11d919e7abdc7b6",
  "public.size_availability(dumpster_size,date,date,integer)": "b553ad0b46deee561956bd203835250c",
  "public.yard_today(timestamp with time zone)": "a4e68e1bb08f6680e28d7cc4ddb66a90",
};
const NEW_FUNCS = [
  "public.booking_delivery_floor(timestamp with time zone)",
  "public._booking_clock()",
  "public._assert_online_delivery_floor(date)",
  "public._stamp_booking_settings()",
];
const SERVICE_ONLY_ACL = "{postgres=X/postgres,service_role=X/postgres}";

const url = fs.readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, "");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const q = async (sql, params) => (await c.query(sql, params)).rows;
let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
  if (!cond) failures++;
};

async function attempt(fn) {
  await c.query("savepoint probe_attempt");
  try {
    const value = await fn();
    await c.query("release savepoint probe_attempt");
    return { ok: true, value };
  } catch (e) {
    await c.query("rollback to savepoint probe_attempt");
    return { ok: false, code: e.code, hint: e.hint, message: e.message };
  }
}
async function undone(fn) {
  await c.query("savepoint probe_undo");
  try {
    return await fn();
  } finally {
    await c.query("rollback to savepoint probe_undo");
  }
}
async function asRole(role, claims, fn) {
  await c.query(`set local role ${role}`);
  await q(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [JSON.stringify(claims), claims.sub ?? ""]);
  try {
    return await fn();
  } finally {
    await c.query("reset role");
    await q(`select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)`);
  }
}
const svc = (fn) => asRole("service_role", { role: "service_role" }, fn);
const authed = (sub, fn) => asRole("authenticated", { sub, role: "authenticated" }, fn);
const anon = (fn) => asRole("anon", { role: "anon" }, fn);

const fnInfo = async (sig) =>
  (
    await q(
      `select md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as md5, coalesce(p.proacl::text, '(default)') as acl,
              pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as result,
              p.prosecdef as definer, p.proconfig::text as config, l.lanname as lang
         from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = to_regprocedure($1)`,
      [sig],
    )
  )[0];
const name = (sig) => sig.split("(")[0].replace("public.", "");

/** Fake the booking clock: a yard-local wall time, e.g. '2026-11-11 15:09:59'. */
const setClock = (local) =>
  c.query(`create or replace function public._booking_clock() returns timestamptz language sql stable security invoker
           set search_path = public as $$ select timestamp '${local}' at time zone 'America/New_York' $$`);
const setCutoff = (enabled, time = "15:00") => q(`update public.cl_booking_settings set cutoff_enabled = $1, cutoff_time = $2`, [enabled, time]);

const counts = async () =>
  (
    await q(`select (select count(*) from public.bookings)::int as bookings, (select count(*) from public.jobs)::int as jobs,
                    (select count(*) from public.customers)::int as customers, (select count(*) from public.agreement_sessions)::int as agreements,
                    (select count(*) from public.pay_links)::int as pay_links, (select count(*) from public.consent_records)::int as consents,
                    (select md5(coalesce(string_agg(id::text || status::text || updated_at::text, ',' order by id), '')) from public.bookings) as bookings_fp`)
  )[0];

const before = { counts: null, fns: {} };
await c.connect();
before.counts = await counts();
console.log(`before: ${JSON.stringify({ ...before.counts, bookings_fp: before.counts.bookings_fp.slice(0, 8) })}`);

try {
  await c.query("begin");
  const applied = (await q(`select to_regclass('public.cl_booking_settings') is not null as a`))[0].a;

  console.log("-- md5 and ACL before");
  for (const [sig, pin] of Object.entries({ ...REBUILT, ...UNTOUCHED })) {
    const f = await fnInfo(sig);
    before.fns[sig] = f;
    console.log(`   ${name(sig).padEnd(30)} md5 ${f.md5}  acl ${f.acl}`);
    if (!applied) ok(`${name(sig)}: live md5 is the one the migration was built from`, f.md5 === pin, f.md5);
  }

  if (applied) console.log("-- migration already applied: probing the live definitions");
  else {
    await c.query(fs.readFileSync(MIGRATION, "utf8"));
    console.log("-- migration applied inside the transaction");
  }

  console.log("-- md5 and ACL after");
  for (const sig of Object.keys({ ...REBUILT, ...UNTOUCHED })) {
    const f = await fnInfo(sig);
    const b = before.fns[sig];
    console.log(`   ${name(sig).padEnd(30)} md5 ${f.md5}  acl ${f.acl}`);
    if (sig in UNTOUCHED) ok(`${name(sig)}: unchanged (md5 and ACL)`, f.md5 === UNTOUCHED[sig] && f.acl === b.acl);
    else if (!applied)
      ok(`${name(sig)}: rebuilt with the same signature, result, security, search_path and ACL`,
        f.md5 !== b.md5 && f.args === b.args && f.result === b.result && f.definer === b.definer && f.config === b.config && f.acl === b.acl,
        { lang: `${b.lang}->${f.lang}` });
  }
  // booking_delivery_floor is DEFINER (it reads the owner-only yard_today) and
  // callable by service_role; the other three are owner-only INVOKER helpers.
  for (const sig of NEW_FUNCS) {
    const f = await fnInfo(sig);
    const isFloor = sig.startsWith("public.booking_delivery_floor(");
    const expectAcl = isFloor ? SERVICE_ONLY_ACL : "{postgres=X/postgres}";
    ok(`new ${name(sig)}: ${isFloor ? "DEFINER" : "INVOKER"}, ACL ${expectAcl}, search_path=public`,
      f && f.definer === isFloor && f.acl === expectAcl && f.config === "{search_path=public}", f && { acl: f.acl, definer: f.definer, md5: f.md5 });
  }

  console.log("-- the settings table");
  const tbl = (await q(`select c.relrowsecurity as rls,
      has_table_privilege('anon', c.oid, 'SELECT') as anon_sel,
      has_table_privilege('authenticated', c.oid, 'SELECT') as auth_sel,
      has_table_privilege('authenticated', c.oid, 'INSERT') as auth_ins,
      has_table_privilege('authenticated', c.oid, 'DELETE') as auth_del,
      has_column_privilege('authenticated', c.oid, 'cutoff_enabled', 'UPDATE') as upd_enabled,
      has_column_privilege('authenticated', c.oid, 'cutoff_time', 'UPDATE') as upd_time,
      has_column_privilege('authenticated', c.oid, 'updated_by', 'UPDATE') as upd_by,
      has_column_privilege('authenticated', c.oid, 'id', 'UPDATE') as upd_id
    from pg_class c where c.oid = 'public.cl_booking_settings'::regclass`))[0];
  ok("RLS on; anon nothing; authenticated read + update of the two setting columns only",
    tbl.rls && !tbl.anon_sel && tbl.auth_sel && !tbl.auth_ins && !tbl.auth_del && tbl.upd_enabled && tbl.upd_time && !tbl.upd_by && !tbl.upd_id, tbl);
  const row = (await q(`select cutoff_enabled, cutoff_time::text as t, (select count(*)::int from public.cl_booking_settings) as n from public.cl_booking_settings`))[0];
  ok("one row, shipped OFF at 15:00", row.n === 1 && row.cutoff_enabled === false && row.t === "15:00:00", row);

  console.log("-- the floor, faked clock (booking_delivery_floor(p_now), service_role)");
  const floorAt = (utc) =>
    svc(async () =>
      (await q(`select earliest_online::text as online, earliest_staff::text as staff, after_cutoff as after,
                to_char(next_change_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as next
                from public.booking_delivery_floor($1::timestamptz)`, [utc]))[0]);
  const cases = [
    // [label, cutoff on?, cutoff, utc instant, online, staff, after, next change (UTC)]
    ["off, any time", false, "15:00", "2026-11-12T20:00:00Z", "2026-11-13", "2026-11-13", false, "2026-11-13T05:00:00Z"],
    ["EST 14:59:59", true, "15:00", "2026-11-12T19:59:59Z", "2026-11-13", "2026-11-13", false, "2026-11-12T20:00:00Z"],
    ["EST 15:00:00 (at the cutoff = after)", true, "15:00", "2026-11-12T20:00:00Z", "2026-11-14", "2026-11-13", true, "2026-11-13T05:00:00Z"],
    ["EDT Oct 31 14:59:59", true, "15:00", "2026-10-31T18:59:59Z", "2026-11-01", "2026-11-01", false, "2026-10-31T19:00:00Z"],
    ["EDT Oct 31 15:00", true, "15:00", "2026-10-31T19:00:00Z", "2026-11-02", "2026-11-01", true, "2026-11-01T04:00:00Z"],
    ["Nov 1 01:30 EDT (first)", true, "15:00", "2026-11-01T05:30:00Z", "2026-11-02", "2026-11-02", false, "2026-11-01T20:00:00Z"],
    ["Nov 1 01:30 EST (repeated)", true, "15:00", "2026-11-01T06:30:00Z", "2026-11-02", "2026-11-02", false, "2026-11-01T20:00:00Z"],
    ["Nov 1 14:59:59 EST", true, "15:00", "2026-11-01T19:59:59Z", "2026-11-02", "2026-11-02", false, "2026-11-01T20:00:00Z"],
    ["Nov 1 15:00 EST", true, "15:00", "2026-11-01T20:00:00Z", "2026-11-03", "2026-11-02", true, "2026-11-02T05:00:00Z"],
    ["Nov 1, cutoff 03:00, 02:59:59 EST", true, "03:00", "2026-11-01T07:59:59Z", "2026-11-02", "2026-11-02", false, "2026-11-01T08:00:00Z"],
    ["Nov 1, cutoff 03:00, 03:00 EST", true, "03:00", "2026-11-01T08:00:00Z", "2026-11-03", "2026-11-02", true, "2026-11-02T05:00:00Z"],
    ["23:59:59 after the cutoff", true, "15:00", "2026-11-12T04:59:59Z", "2026-11-13", "2026-11-12", true, "2026-11-12T05:00:00Z"],
    ["00:00 next day, before the cutoff", true, "15:00", "2026-11-12T05:00:00Z", "2026-11-13", "2026-11-13", false, "2026-11-12T20:00:00Z"],
    ["cutoff 23:45, 23:44:59", true, "23:45", "2026-11-12T04:44:59Z", "2026-11-12", "2026-11-12", false, "2026-11-12T04:45:00Z"],
    ["cutoff 23:45, 23:45", true, "23:45", "2026-11-12T04:45:00Z", "2026-11-13", "2026-11-12", true, "2026-11-12T05:00:00Z"],
    ["Mar 14 2027 01:30 EST (before spring forward)", true, "15:00", "2027-03-14T06:30:00Z", "2027-03-15", "2027-03-15", false, "2027-03-14T19:00:00Z"],
    ["Mar 14 2027 14:59:59 EDT", true, "15:00", "2027-03-14T18:59:59Z", "2027-03-15", "2027-03-15", false, "2027-03-14T19:00:00Z"],
    ["Mar 14 2027 15:00 EDT", true, "15:00", "2027-03-14T19:00:00Z", "2027-03-16", "2027-03-15", true, "2027-03-15T04:00:00Z"],
    ["Mar 14 2027, cutoff 03:00, 01:59:59 EST", true, "03:00", "2027-03-14T06:59:59Z", "2027-03-15", "2027-03-15", false, "2027-03-14T07:00:00Z"],
    ["Mar 14 2027, cutoff 03:00, 03:00 EDT", true, "03:00", "2027-03-14T07:00:00Z", "2027-03-16", "2027-03-15", true, "2027-03-15T04:00:00Z"],
  ];
  for (const [label, on, cut, utc, online, staff, after, next] of cases) {
    await setCutoff(on, cut);
    const f = await floorAt(utc);
    ok(`floor: ${label}`, f.online === online && f.staff === staff && f.after === after && f.next === next, f);
  }
  await undone(async () => {
    await q(`delete from public.cl_booking_settings`);
    const f = await floorAt("2026-11-12T20:00:00Z");
    ok("settings row missing: fails safe to today's rule (tomorrow, cutoff off)", f.online === "2026-11-13" && f.after === false, f);
  });

  console.log("-- who can read and change the setting");
  const owner = (await q(`select id from public.profiles where role = 'owner' and not is_protected and not hidden_from_users and removed_at is null order by created_at limit 1`))[0].id;
  const customer = (await q(`select id from public.profiles where role = 'customer' order by created_at limit 1`))[0].id;
  const staffId = (await q(`insert into auth.users (id, aud, role, email, email_confirmed_at) values (gen_random_uuid(), 'authenticated', 'authenticated', $1, now()) returning id::text`, [`cutoff-probe-staff-${TAG}@example.com`]))[0].id;
  await q(`delete from public.profiles where id = $1`, [staffId]);
  await q(`insert into public.profiles (id, role, full_name) values ($1, 'staff', 'Cutoff probe staff')`, [staffId]);
  await setCutoff(false, "15:00");
  const upd = (who, set, val) => authed(who, () => attempt(async () => (await c.query(`update public.cl_booking_settings set ${set} = $1`, [val])).rowCount));
  for (const bad of ["02:45", "02:59", "15:10", "23:50", "24:00", "15:00:30"]) {
    const r = await upd(owner, "cutoff_time", bad);
    ok(`owner: cutoff ${bad} refused 23514`, !r.ok && r.code === "23514", r.ok ? r : { code: r.code });
  }
  const nul = await upd(owner, "cutoff_time", null);
  ok("owner: cutoff null refused 23502", !nul.ok && nul.code === "23502", nul.ok ? nul : { code: nul.code });
  await undone(async () => {
    const good = await upd(owner, "cutoff_time", "15:15");
    const on = await upd(owner, "cutoff_enabled", true);
    const r = (await q(`select cutoff_time::text as t, cutoff_enabled as e, updated_by::text as by from public.cl_booking_settings`))[0];
    ok("owner: 15:15 and on saved, updated_by stamped with the owner", good.value === 1 && on.value === 1 && r.t === "15:15:00" && r.e && r.by === owner, { by: short(r.by) });
  });
  for (const [col, val] of [["updated_by", owner], ["id", true]]) {
    const r = await upd(owner, col, val);
    ok(`owner: writing ${col} refused 42501`, !r.ok && r.code === "42501", r.ok ? r : { code: r.code });
  }
  const ins = await authed(owner, () => attempt(() => q(`insert into public.cl_booking_settings (id) values (true)`)));
  const del = await authed(owner, () => attempt(() => q(`delete from public.cl_booking_settings`)));
  ok("owner: insert and delete refused 42501", !ins.ok && ins.code === "42501" && !del.ok && del.code === "42501", { ins: ins.code, del: del.code });
  const staffRead = await authed(staffId, () => attempt(async () => (await q(`select count(*)::int as n from public.cl_booking_settings`))[0].n));
  const staffUpd = await upd(staffId, "cutoff_enabled", true);
  ok("staff: reads the setting, can't change it (0 rows)", staffRead.value === 1 && staffUpd.ok && staffUpd.value === 0, { read: staffRead.value, updated: staffUpd.value });
  const custRead = await authed(customer, () => attempt(async () => (await q(`select count(*)::int as n from public.cl_booking_settings`))[0].n));
  const custUpd = await upd(customer, "cutoff_enabled", true);
  ok("customer: sees no row, changes nothing", custRead.value === 0 && custUpd.ok && custUpd.value === 0, { read: custRead.value, updated: custUpd.value });
  const anonRead = await anon(() => attempt(() => q(`select * from public.cl_booking_settings`)));
  ok("anon: refused 42501", !anonRead.ok && anonRead.code === "42501", { code: anonRead.code });
  for (const [who, run] of [["owner", (fn) => authed(owner, fn)], ["customer", (fn) => authed(customer, fn)], ["anon", anon], ["service_role", svc]]) {
    if (who === "service_role") {
      const r = [
        await run(() => attempt(() => q(`select public._assert_online_delivery_floor(current_date + 1)`))),
        await run(() => attempt(() => q(`select public._booking_clock()`))),
      ];
      const floor = await run(() => attempt(() => q(`select * from public.booking_delivery_floor()`)));
      ok("service_role: calls the floor; the assert and clock refused 42501", floor.ok && r.every((x) => !x.ok && x.code === "42501"), r.map((x) => x.code));
      continue;
    }
    const r = [
      await run(() => attempt(() => q(`select * from public.booking_delivery_floor()`))),
      await run(() => attempt(() => q(`select public._assert_online_delivery_floor(current_date + 1)`))),
      await run(() => attempt(() => q(`select public._booking_clock()`))),
    ];
    ok(`${who}: the floor, assert and clock functions refused 42501`, r.every((x) => !x.ok && x.code === "42501"), r.map((x) => x.code));
  }
  ok("settings still off after the refused writes", (await q(`select cutoff_enabled from public.cl_booking_settings`))[0].cutoff_enabled === false);

  console.log("-- bookings on the real yard day with a faked time of day (cutoff 15:00 on)");
  const today = (await q(`select public.yard_today()::text as d, (public.yard_today() + 1)::text as t1, (public.yard_today() + 2)::text as t2`))[0];
  console.log(`   yard today ${today.d}; tomorrow ${today.t1}`);
  await setCutoff(true, "15:00");
  const newSession = async () =>
    (await q(`insert into public.agreement_sessions (signer_name, signer_email, status, verified_at, completed_at, envelope_id)
              values ('Cutoff Probe', $1, 'completed', now(), now(), $2) returning id::text`, [SIGNER, `probe-env-${crypto.randomUUID()}`]))[0].id;
  const session = async (id) => (await q(`select consumed_booking_id::text as booking, consumed_at is not null as consumed, status from public.agreement_sessions where id = $1`, [id]))[0];
  const online = (date, sessionId) =>
    svc(() =>
      attempt(async () =>
        (await q(`select public.create_booking(p_size => '20yd', p_delivery_date => $1::date, p_delivery_address => '1 Probe St, Columbus, OH 43215',
                   p_contact_name => 'Cutoff Probe', p_rental_days => 1, p_contact_email => $2, p_agreement_session_id => $3::uuid) as id`,
          [date, SIGNER, sessionId]))[0].id,
      ),
    );
  const phone = (date) =>
    authed(owner, () =>
      attempt(async () =>
        (await q(`select public.staff_create_booking(p_size => '20yd', p_delivery_date => $1::date, p_delivery_address => '1 Probe St, Columbus, OH 43215',
                   p_contact_name => 'Cutoff Probe', p_rental_days => 1, p_contact_email => $2) as id`, [date, SIGNER]))[0].id,
      ),
    );
  const payLink = (date) =>
    authed(owner, () =>
      attempt(async () =>
        (await q(`select booking_id::text, token is not null as has_token from public.staff_create_pay_link_booking(p_size => '20yd', p_delivery_date => $1::date,
                   p_delivery_address => '1 Probe St, Columbus, OH 43215', p_contact_name => 'Cutoff Probe', p_rental_days => 1, p_contact_email => $2)`, [date, SIGNER]))[0],
      ),
    );
  const cutoffRefusal = (r) => !r.ok && r.code === "P0001" && r.hint === "after_cutoff" && /order cutoff/.test(r.message);

  await undone(async () => {
    await setClock(`${today.d} 14:59:59`);
    const s = await newSession();
    const r = await online(today.t1, s);
    const st = await session(s);
    ok("online 14:59:59, tomorrow: booked; the signed agreement is consumed by that booking",
      r.ok && st.booking === r.value && st.consumed, r.ok ? { booking: short(r.value), session: short(s) } : { code: r.code, hint: r.hint });
  });
  await undone(async () => {
    const s = await newSession();
    const nBefore = (await counts()).bookings;
    await setClock(`${today.d} 15:10:00`);
    const refused = await online(today.t1, s);
    const st = await session(s);
    ok("online 15:10:00 (cutoff + grace), tomorrow: refused after_cutoff; agreement NOT consumed; no booking",
      cutoffRefusal(refused) && st.booking === null && !st.consumed && st.status === "completed" && (await counts()).bookings === nBefore,
      { code: refused.code, hint: refused.hint, consumed: st.consumed });
    console.log(`      message: ${refused.message}`);
    await setClock(`${today.d} 15:09:59`);
    const graced = await online(today.t1, s);
    const st2 = await session(s);
    ok("online 15:09:59 (inside the 10-minute grace), tomorrow: booked with the same, still-unused agreement",
      graced.ok && st2.booking === graced.value, graced.ok ? { booking: short(graced.value) } : { code: graced.code });
  });
  await undone(async () => {
    await setClock(`${today.d} 15:10:00`);
    const s = await newSession();
    const r = await online(today.t2, s);
    ok("online after the cutoff, the day after tomorrow: booked, agreement consumed", r.ok && (await session(s)).booking === r.value, r.ok ? undefined : { code: r.code });
  });
  await undone(async () => {
    await setClock(`${today.d} 15:10:00`);
    const s = await newSession();
    const r = await online(today.d, s);
    ok("online after the cutoff, TODAY: refused by the core's own tomorrow rule (not after_cutoff); agreement not consumed",
      !r.ok && r.hint === "unavailable" && /tomorrow or later/.test(r.message) && (await session(s)).booking === null, { hint: r.hint });
  });
  await undone(async () => {
    await setClock(`${today.d} 23:30:00`);
    const r = await phone(today.t1);
    ok("STAFF PHONE 23:30, tomorrow: booked (the cutoff never applies)", r.ok, r.ok ? { booking: short(r.value) } : { code: r.code, hint: r.hint });
  });
  await undone(async () => {
    await q(`update public.cl_pay_link_settings set enabled = true`);
    await setClock(`${today.d} 15:10:00`);
    const nb = await counts();
    const refused = await payLink(today.t1);
    const na = await counts();
    ok("pay link 15:10, tomorrow: refused after_cutoff; no booking, no pay link",
      cutoffRefusal(refused) && na.bookings === nb.bookings && na.pay_links === nb.pay_links, { code: refused.code, hint: refused.hint });
    await setClock(`${today.d} 14:59:59`);
    const r = await payLink(today.t1);
    ok("pay link 14:59:59, tomorrow: booked and a link issued", r.ok && r.value.has_token, r.ok ? { booking: short(r.value.booking_id) } : { code: r.code, hint: r.hint });
    await setClock(`${today.d} 15:10:00`);
    const later = await payLink(today.t2);
    ok("pay link after the cutoff, the day after tomorrow: booked", later.ok, later.ok ? undefined : { code: later.code });
  });
  await undone(async () => {
    await setCutoff(false);
    await setClock(`${today.d} 23:30:00`);
    const s = await newSession();
    const r = await online(today.t1, s);
    ok("cutoff OFF, online 23:30, tomorrow: booked as today (agreement consumed)", r.ok && (await session(s)).booking === r.value, r.ok ? undefined : { code: r.code });
  });
  await undone(async () => {
    await q(`delete from public.cl_booking_settings`);
    await setClock(`${today.d} 23:30:00`);
    const s = await newSession();
    const r = await online(today.t1, s);
    ok("settings row missing: online 23:30, tomorrow: booked (fails safe to today's rule)", r.ok, r.ok ? undefined : { code: r.code });
  });

  const inside = await counts();
  ok("counts and real bookings unchanged inside the transaction (every scenario undone)",
    JSON.stringify({ ...inside, customers: 0 }) === JSON.stringify({ ...before.counts, customers: 0 }) && inside.customers === before.counts.customers,
    { before: before.counts.bookings, inside: inside.bookings });
} finally {
  await c.query("rollback");
}

const after = await counts();
const gone = (await q(`select to_regclass('public.cl_booking_settings') is null as t, to_regprocedure('public._booking_clock()') is null as f`))[0];
const fnsAfter = {};
for (const sig of Object.keys({ ...REBUILT, ...UNTOUCHED })) fnsAfter[sig] = await fnInfo(sig);
console.log("-- after rollback");
ok("counts identical (bookings, jobs, customers, agreements, pay links, consents) and real bookings unchanged",
  JSON.stringify(after) === JSON.stringify(before.counts), { bookings: after.bookings, agreements: after.agreements, pay_links: after.pay_links });
ok("every function back to its live md5 and ACL",
  Object.keys(fnsAfter).every((s) => fnsAfter[s].md5 === before.fns[s].md5 && fnsAfter[s].acl === before.fns[s].acl));
console.log(`   live state after rollback: settings table absent=${gone.t}, _booking_clock absent=${gone.f}`);
await c.end();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
