// Rolled-back probe for supabase/migrations/20261117000000_agreement_mode.sql.
//
//   node --use-system-ca scripts/probe-agreement-mode.mjs     (repo root; reads DATABASE_URL from .env.local)
//
// Everything runs in ONE transaction that is always rolled back (finally): the
// migration, every change to the new settings row and a throwaway staff
// account. Nothing here books, charges or calls DocuSign.
//
// Pins: md5 (carriage returns removed) and ACL of the functions the migration
// reuses or must leave alone, and the whole shape and row of
// cl_booking_settings, before and after. Prints ids shortened, never names or
// emails.
//
// PROBE_MIGRATION overrides the file (mutation runs only).
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

const MIGRATION = process.env.PROBE_MIGRATION || "supabase/migrations/20261117000000_agreement_mode.sql";
const TAG = crypto.randomUUID().slice(0, 8);
const short = (id) => String(id).slice(0, 8);
const SERVICE_ONLY_ACL = "{postgres=X/postgres,service_role=X/postgres}";
const OWNER_ONLY_ACL = "{postgres=X/postgres}";

// Read live 2026-11-17 (read-only) and must not change.
const PINNED = {
  "public.set_updated_at()": "4d6804d5850641a33867814c9e76a714",
  "public._stamp_booking_settings()": "5da663bea5116945a6c327815bfe5bb9",
  "public.booking_delivery_floor(timestamp with time zone)": "d1db7a65014955af275efaefe8d26a5c",
  "public.is_staff()": "afca5031acab0ff5663da259a27c9504",
  "public.is_owner()": "264fa90167513cdebd868a2fc8fffe67",
  "public.create_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,uuid,boolean,uuid)": "5caa6553fb3482439a75926ed8ab764a",
  "public._create_booking_core(dumpster_size,date,text,text,integer,text,text,text,text,text,uuid,boolean,uuid,text,uuid,uuid)": "e8245ce0504d55f53bad223cba209d60",
};

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
    return { ok: false, code: e.code, message: e.message };
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
// `attempt` always leaves the transaction usable, so the role can be reset.
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
              pg_get_function_result(p.oid) as result, p.prosecdef as definer, p.proconfig::text as config, p.provolatile as vol
         from pg_proc p where p.oid = to_regprocedure($1)`,
      [sig],
    )
  )[0];
const name = (sig) => sig.split("(")[0].replace("public.", "");
const bookingSettings = async () =>
  (
    await q(`select
      (select relacl::text from pg_class where oid = 'public.cl_booking_settings'::regclass) as acl,
      (select string_agg(polname || '|' || polcmd::text || '|' || coalesce(pg_get_expr(polqual, polrelid), '') || '|' || coalesce(pg_get_expr(polwithcheck, polrelid), ''), ';' order by polname)
         from pg_policy where polrelid = 'public.cl_booking_settings'::regclass) as policies,
      (select string_agg(pg_get_triggerdef(oid), ';' order by tgname) from pg_trigger where tgrelid = 'public.cl_booking_settings'::regclass and not tgisinternal) as triggers,
      (select string_agg(column_name || ':' || data_type || ':' || coalesce(column_default, ''), ',' order by ordinal_position)
         from information_schema.columns where table_schema = 'public' and table_name = 'cl_booking_settings') as columns,
      (select string_agg(conname || ':' || pg_get_constraintdef(oid), ';' order by conname) from pg_constraint where conrelid = 'public.cl_booking_settings'::regclass) as constraints,
      (select row_to_json(b)::text from public.cl_booking_settings b) as row_`)
  )[0];

const before = { fns: {}, booking: null };
await c.connect();

try {
  await c.query("begin");
  const applied = (await q(`select to_regclass('public.cl_agreement_settings') is not null as a`))[0].a;

  console.log("-- before");
  for (const [sig, pin] of Object.entries(PINNED)) {
    const f = await fnInfo(sig);
    before.fns[sig] = f;
    console.log(`   ${name(sig).padEnd(24)} md5 ${f.md5}  acl ${f.acl}`);
    if (!applied) ok(`${name(sig)}: live md5 is the one read when the migration was written`, f.md5 === pin, f.md5);
  }
  before.booking = await bookingSettings();

  if (applied) console.log("-- migration already applied: probing the live definitions");
  else {
    await c.query(fs.readFileSync(MIGRATION, "utf8"));
    console.log("-- migration applied inside the transaction");
  }

  console.log("-- nothing else changed");
  for (const sig of Object.keys(PINNED)) {
    const f = await fnInfo(sig);
    ok(`${name(sig)}: unchanged (md5 and ACL)`, f.md5 === before.fns[sig].md5 && f.acl === before.fns[sig].acl);
  }
  const booking = await bookingSettings();
  for (const k of Object.keys(booking)) ok(`cl_booking_settings ${k.replace("_", "")}: unchanged`, booking[k] === before.booking[k]);

  console.log("-- the table");
  const cols = (await q(`select string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' order by ordinal_position) as s
      from information_schema.columns where table_schema = 'public' and table_name = 'cl_agreement_settings'`))[0].s;
  ok("columns: id, mode (text, not null, default attest), updated_at, updated_by",
    cols === "id:boolean:NO:true,mode:text:NO:'attest'::text,updated_at:timestamp with time zone:NO:now(),updated_by:uuid:YES:", cols);
  const cons = (await q(`select string_agg(conname || ':' || pg_get_constraintdef(oid), ';' order by conname) as s from pg_constraint where conrelid = 'public.cl_agreement_settings'::regclass`))[0].s;
  ok("constraints: id check, mode check (two values), pk, updated_by -> profiles on delete set null",
    /cl_agreement_settings_id_check:CHECK \(id\)/.test(cons) && /cl_agreement_settings_mode_check:CHECK .*'attest'.*'docusign'/.test(cons) &&
      /PRIMARY KEY \(id\)/.test(cons) && /FOREIGN KEY \(updated_by\) REFERENCES profiles\(id\) ON DELETE SET NULL/.test(cons), cons);
  const tbl = (await q(`select c.relrowsecurity as rls, c.relacl::text as acl,
      has_table_privilege('anon', c.oid, 'SELECT') as anon_sel,
      has_table_privilege('anon', c.oid, 'UPDATE') as anon_upd,
      has_table_privilege('authenticated', c.oid, 'SELECT') as auth_sel,
      has_table_privilege('authenticated', c.oid, 'INSERT') as auth_ins,
      has_table_privilege('authenticated', c.oid, 'DELETE') as auth_del,
      has_column_privilege('authenticated', c.oid, 'mode', 'UPDATE') as upd_mode,
      has_column_privilege('authenticated', c.oid, 'updated_by', 'UPDATE') as upd_by,
      has_column_privilege('authenticated', c.oid, 'updated_at', 'UPDATE') as upd_at,
      has_column_privilege('authenticated', c.oid, 'id', 'UPDATE') as upd_id
    from pg_class c where c.oid = 'public.cl_agreement_settings'::regclass`))[0];
  ok("RLS on; anon nothing; authenticated reads and updates mode only; no insert or delete",
    tbl.rls && !tbl.anon_sel && !tbl.anon_upd && tbl.auth_sel && !tbl.auth_ins && !tbl.auth_del && tbl.upd_mode && !tbl.upd_by && !tbl.upd_at && !tbl.upd_id, tbl);
  const pols = (await q(`select polname, polcmd::text as cmd, polroles::regrole[]::text as roles, pg_get_expr(polqual, polrelid) as u, pg_get_expr(polwithcheck, polrelid) as w
      from pg_policy where polrelid = 'public.cl_agreement_settings'::regclass order by polname`)).map((x) => `${x.polname}|${x.cmd}|${x.roles}|${x.u}|${x.w}`);
  ok("policies: owner update, staff read, authenticated only (as cl_booking_settings)", JSON.stringify(pols) === JSON.stringify([
    "cl_agreement_settings: owner update|w|{authenticated}|is_owner()|is_owner()",
    "cl_agreement_settings: staff read|r|{authenticated}|is_staff()|null",
  ]), pols);
  const trg = (await q(`select string_agg(pg_get_triggerdef(oid), ';' order by tgname) as s from pg_trigger where tgrelid = 'public.cl_agreement_settings'::regclass and not tgisinternal`))[0].s;
  ok("triggers: set_updated_at and the stamp, before update, each row",
    trg === "CREATE TRIGGER cl_agreement_settings_set_updated_at BEFORE UPDATE ON public.cl_agreement_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();" +
      "CREATE TRIGGER cl_agreement_settings_stamp BEFORE UPDATE ON public.cl_agreement_settings FOR EACH ROW EXECUTE FUNCTION _stamp_agreement_settings()", trg);
  const row = (await q(`select (select count(*)::int from public.cl_agreement_settings) as n,
      (select s.mode from public.cl_agreement_settings s limit 1) as mode,
      (select s.updated_by from public.cl_agreement_settings s limit 1) as updated_by`))[0];
  ok("one row, attest, no updated_by", row.n === 1 && row.mode === "attest" && row.updated_by === null, row);

  console.log("-- the check");
  for (const bad of ["Docusign", "DOCUSIGN", "off", "", "docusign "]) {
    const r = await attempt(() => q(`update public.cl_agreement_settings set mode = $1`, [bad]));
    ok(`'${bad}' refused 23514`, !r.ok && r.code === "23514", r.ok ? r : { code: r.code });
  }
  const nul = await attempt(() => q(`update public.cl_agreement_settings set mode = null`));
  ok("null refused 23502", !nul.ok && nul.code === "23502", { code: nul.code });
  const second = await attempt(() => q(`insert into public.cl_agreement_settings (id, mode) values (false, 'docusign')`));
  ok("a second row refused 23514 (singleton)", !second.ok && second.code === "23514", { code: second.code });

  console.log("-- functions");
  const stamp = await fnInfo("public._stamp_agreement_settings()");
  ok(`_stamp_agreement_settings: INVOKER, ACL ${OWNER_ONLY_ACL}, search_path=public`,
    stamp && !stamp.definer && stamp.acl === OWNER_ONLY_ACL && stamp.config === "{search_path=public}", stamp && { acl: stamp.acl, md5: stamp.md5 });
  const f = await fnInfo("public.booking_agreement_mode()");
  console.log(`   booking_agreement_mode md5 ${f?.md5}; _stamp_agreement_settings md5 ${stamp?.md5}`);
  ok(`booking_agreement_mode: DEFINER, stable, returns text, search_path=public, ACL ${SERVICE_ONLY_ACL}`,
    f && f.definer && f.vol === "s" && f.result === "text" && f.config === "{search_path=public}" && f.acl === SERVICE_ONLY_ACL, f && { acl: f.acl, definer: f.definer });
  const viaSvc = () => svc(() => attempt(async () => (await q(`select public.booking_agreement_mode() as m`))[0].m));
  ok("service_role: attest by default", (await viaSvc()).value === "attest");
  await undone(async () => {
    await q(`update public.cl_agreement_settings set mode = 'docusign'`);
    ok("service_role: docusign once set", (await viaSvc()).value === "docusign");
  });
  await undone(async () => {
    await q(`delete from public.cl_agreement_settings`);
    const r = await viaSvc();
    ok("row missing: attest (never docusign by accident)", r.ok && r.value === "attest", r);
  });
  const anonFn = await anon(() => attempt(() => q(`select public.booking_agreement_mode()`)));
  ok("anon: booking_agreement_mode refused 42501", !anonFn.ok && anonFn.code === "42501", { code: anonFn.code });
  const svcStamp = await svc(() => attempt(() => q(`select public._stamp_agreement_settings()`)));
  ok("service_role: the stamp function refused (42501, not callable)", !svcStamp.ok && svcStamp.code === "42501", { code: svcStamp.code });

  console.log("-- who can read and change the mode");
  const owner = (await q(`select id from public.profiles where role = 'owner' and not is_protected and not hidden_from_users and removed_at is null order by created_at limit 1`))[0].id;
  const customer = (await q(`select id from public.profiles where role = 'customer' order by created_at limit 1`))[0].id;
  const staffId = (await q(`insert into auth.users (id, aud, role, email, email_confirmed_at) values (gen_random_uuid(), 'authenticated', 'authenticated', $1, now()) returning id::text`, [`agreement-mode-probe-staff-${TAG}@example.com`]))[0].id;
  await q(`delete from public.profiles where id = $1`, [staffId]);
  await q(`insert into public.profiles (id, role, full_name) values ($1, 'staff', 'Agreement mode probe staff')`, [staffId]);
  console.log(`   owner ${short(owner)}, throwaway staff ${short(staffId)}`);
  const upd = (who, col, val) => authed(who, () => attempt(async () => (await c.query(`update public.cl_agreement_settings set ${col} = $1`, [val])).rowCount));

  for (const [who, id] of [["owner", owner], ["customer", customer]]) {
    const r = await authed(id, () => attempt(() => q(`select public.booking_agreement_mode()`)));
    ok(`${who} (authenticated): booking_agreement_mode refused 42501`, !r.ok && r.code === "42501", { code: r.code });
  }
  await undone(async () => {
    // (updated_at can't be seen to move inside one transaction: now() is fixed.
    // Its trigger is pinned above.)
    const r = await upd(owner, "mode", "docusign");
    const after = (await q(`select mode, updated_by::text as by from public.cl_agreement_settings`))[0];
    ok("owner: docusign saved (1 row), updated_by stamped with the owner",
      r.ok && r.value === 1 && after.mode === "docusign" && after.by === owner, { by: short(after.by) });
    const back = await upd(owner, "mode", "attest");
    ok("owner: back to attest (1 row)", back.ok && back.value === 1);
  });
  const badOwner = await upd(owner, "mode", "on");
  ok("owner: a value outside the two refused 23514", !badOwner.ok && badOwner.code === "23514", { code: badOwner.code });
  for (const [col, val] of [["updated_by", owner], ["id", true]]) {
    const r = await upd(owner, col, val);
    ok(`owner: writing ${col} refused 42501`, !r.ok && r.code === "42501", r.ok ? r : { code: r.code });
  }
  const ins = await authed(owner, () => attempt(() => q(`insert into public.cl_agreement_settings (id) values (true)`)));
  const del = await authed(owner, () => attempt(() => q(`delete from public.cl_agreement_settings`)));
  ok("owner: insert and delete refused 42501", !ins.ok && ins.code === "42501" && !del.ok && del.code === "42501", { ins: ins.code, del: del.code });
  const staffRead = await authed(staffId, () => attempt(async () => (await q(`select mode from public.cl_agreement_settings`)).map((r) => r.mode)));
  const staffUpd = await upd(staffId, "mode", "docusign");
  ok("staff: reads attest, can't change it (0 rows)", staffRead.ok && JSON.stringify(staffRead.value) === '["attest"]' && staffUpd.ok && staffUpd.value === 0, { read: staffRead.value, updated: staffUpd.value });
  const custRead = await authed(customer, () => attempt(async () => (await q(`select mode from public.cl_agreement_settings`)).length));
  const custUpd = await upd(customer, "mode", "docusign");
  ok("customer: sees no row, changes nothing", custRead.value === 0 && custUpd.ok && custUpd.value === 0, { read: custRead.value, updated: custUpd.value });
  const anonRead = await anon(() => attempt(() => q(`select mode from public.cl_agreement_settings`)));
  const anonUpd = await anon(() => attempt(() => q(`update public.cl_agreement_settings set mode = 'docusign'`)));
  ok("anon: read and update refused 42501", !anonRead.ok && anonRead.code === "42501" && !anonUpd.ok && anonUpd.code === "42501", { read: anonRead.code, upd: anonUpd.code });
  const finalMode = (await q(`select mode from public.cl_agreement_settings`))[0].mode;
  ok("after every attempt the row is still attest", finalMode === "attest", finalMode);
} finally {
  await c.query("rollback");
}

console.log("-- after rollback");
const gone = (await q(`select to_regclass('public.cl_agreement_settings') is null as t, to_regprocedure('public.booking_agreement_mode()') is null as f, to_regprocedure('public._stamp_agreement_settings()') is null as s`))[0];
const fnsAfter = {};
for (const sig of Object.keys(before.fns)) fnsAfter[sig] = await fnInfo(sig);
ok("every pinned function back to its live md5 and ACL",
  Object.keys(fnsAfter).every((s) => fnsAfter[s].md5 === before.fns[s].md5 && fnsAfter[s].acl === before.fns[s].acl));
ok("cl_booking_settings (shape and row) unchanged", JSON.stringify(await bookingSettings()) === JSON.stringify(before.booking));
ok("nothing of the migration left live", gone.t && gone.f && gone.s, gone);
await c.end();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
