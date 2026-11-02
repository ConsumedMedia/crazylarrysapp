// Rolled-back probe for supabase/migrations/20261103000000_pay_links.sql.
//
//   node scripts/probe-pay-links.mjs        (repo root; reads DATABASE_URL from .env.local)
//
// Everything runs in ONE transaction that is always rolled back (finally):
// the migration itself, throwaway staff/owner/customer accounts, every
// booking, link, payment and consent row the checks create. Nothing persists,
// nothing is sent (the database never sends), and no card is charged (charge
// ids are fake strings). The migration holds table locks on bookings,
// invoices and payment_attempts for the few seconds this runs; lock_timeout
// stops it from queueing behind live traffic.
//
// It checks:
//   - existing functions the CURRENT production code calls are untouched
//     (md5 + ACL) and still work, as service_role and as authenticated staff:
//     create_booking, record_payment, staff_create_booking,
//     record_manual_payment, set_booking_status (cancel), cancel_and_refund,
//     record_invoice_issued, record_invoice_payment_detected
//   - new tables: RLS on, grants exactly as intended; function EXECUTE matrix
//   - settings defaults (feature OFF, N=2, M=3, repeat off, max 3) and that
//     only an owner can change them; recipient validation
//   - the pay-link flow: contact rule, consent record, token never stored,
//     lookup, rate limit, resend, QBO-invoice refusal, begin/clear charge,
//     record payment (idempotent, refusals), agreement time on the link
//   - the bookings trigger ends links on cash/check, cancel and refund
//   - reminder/alert schedule in yard days across the Nov 1 clock change,
//     no reminders after delivery, claims can't repeat, feature off = nothing
//   - staff-alert recipients: hidden owners never in the fallback
//   - the notifications_log token scan catches a planted live token
//   - after ROLLBACK every md5, ACL and row count matches the start
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

const MIGRATION = "supabase/migrations/20261103000000_pay_links.sql";
const TAG = crypto.randomUUID().slice(0, 8);
const mail = (who) => `pay-link-probe-${TAG}-${who}@example.com`;

const url = fs.readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, "");
pg.types.setTypeParser(1082, (v) => v); // date stays 'YYYY-MM-DD'
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric -> number
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const q = async (sql, params) => (await c.query(sql, params)).rows;
let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
  if (!cond) failures++;
};

// Functions the production code on users-page calls today. create_booking and
// _create_booking_core carry the extra agreement-session argument from main's
// applied 20260929000000 (users-page's 12-argument call still resolves: the
// 13th defaults to null).
const EXISTING = [
  "public.create_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,uuid,boolean,uuid)",
  "public.staff_create_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,boolean,uuid)",
  "public._create_booking_core(dumpster_size,date,text,text,integer,text,text,text,text,text,uuid,boolean,uuid,text,uuid,uuid)",
  "public.record_payment(uuid,text,text,numeric)",
  "public.record_manual_payment(uuid,text,text,text)",
  "public.record_invoice_issued(uuid,text,text,text)",
  "public.record_invoice_payment_detected(uuid,text,text)",
  "public.record_payment_attempt(text,text,text,numeric,text,text,jsonb)",
  "public.set_booking_status(uuid,booking_status)",
  "public.cancel_and_refund(uuid,text,text,numeric)",
  "public.booking_quote(dumpster_size)",
  "public.size_availability(dumpster_size,date,date,integer)",
];
const NEW_TABLES = ["cl_pay_link_settings", "pay_links", "pay_link_events", "consent_records", "pay_link_lookup_attempts"];

async function fnAttrs(sig) {
  const r = await q(`select md5(pg_get_functiondef(p.oid)) as md5, p.proacl::text as acl, p.prosecdef as secdef
                       from pg_proc p where p.oid = to_regprocedure($1)`, [sig]);
  return r[0] ?? null;
}
async function snapshot() {
  await c.query("begin transaction read only");
  try {
    const fns = {};
    for (const sig of EXISTING) fns[sig] = await fnAttrs(sig);
    const counts = (await q(`select
      (select count(*)::int from public.bookings) as bookings,
      (select count(*)::int from public.jobs) as jobs,
      (select count(*)::int from public.customers) as customers,
      (select count(*)::int from public.invoices) as invoices,
      (select count(*)::int from public.payment_attempts) as payment_attempts,
      (select count(*)::int from public.notifications_log) as notifications_log,
      (select count(*)::int from public.status_log) as status_log,
      (select count(*)::int from public.profiles) as profiles,
      (select count(*)::int from auth.users) as auth_users,
      (select count(*)::int from auth.users where email like 'pay-link-probe-%') as probe_users,
      (select count(*)::int from supabase_migrations.schema_migrations) as migrations`))[0];
    const enumVals = (await q(`select '{' || string_agg(enumlabel::text, ',' order by enumsortorder) || '}' as t from pg_enum where enumtypid = 'public.notification_type'::regtype`))[0].t;
    const payLinks = (await q(`select to_regclass('public.pay_links') is not null as e`))[0].e;
    const triggers = (await q(`select string_agg(tgname, ',' order by tgname) as t from pg_trigger
                                where tgrelid = 'public.bookings'::regclass and not tgisinternal`))[0].t;
    const invoiceCols = (await q(`select count(*)::int as n from information_schema.columns
                                   where table_schema = 'public' and table_name = 'invoices'`))[0].n;
    return { fns, counts, enumVals, payLinks, triggers, invoiceCols };
  } finally {
    await c.query("rollback");
  }
}

async function attempt(fn) {
  await c.query("savepoint probe_attempt");
  try {
    const v = await fn();
    await c.query("release savepoint probe_attempt");
    return { ok: true, value: v };
  } catch (e) {
    await c.query("rollback to savepoint probe_attempt");
    return { ok: false, code: e.code, message: e.message, hint: e.hint };
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
const svc = (fn) => asRole("service_role", { role: "service_role" }, fn);
const sAttempt = (sql, params) => svc(() => attempt(() => q(sql, params)));

await c.connect();
const before = await snapshot();
console.log("BEFORE", JSON.stringify({ counts: before.counts, pay_links_exists: before.payLinks, bookings_triggers: before.triggers, notification_types: before.enumVals }));
if (before.payLinks) console.log("NOTE  pay_links already exists: the migration looks applied; this run re-checks it.");
const migrationSql = fs.readFileSync(MIGRATION, "utf8");

try {
  await c.query("begin");
  await c.query("set local lock_timeout = '5s'");
  await c.query("set local statement_timeout = '60s'");
  await c.query(migrationSql);
  ok("migration runs cleanly inside the transaction", true);

  // ------------------------------------------------------------------ shape
  console.log("-- existing functions are untouched by the migration");
  for (const sig of EXISTING) {
    const a = await fnAttrs(sig);
    ok(`unchanged: ${sig.replace("public.", "").split("(")[0]}`,
      !!a && a.md5 === before.fns[sig]?.md5 && a.acl === before.fns[sig]?.acl);
  }
  const enumNow = (await q(`select '{' || string_agg(enumlabel::text, ',' order by enumsortorder) || '}' as t from pg_enum where enumtypid = 'public.notification_type'::regtype`))[0].t;
  ok("notification_type gains pay_link, pay_link_reminder, staff_unpaid_alert (existing values kept, in order)",
    enumNow === before.enumVals.replace(/}$/, ",pay_link,pay_link_reminder,staff_unpaid_alert}") || (before.payLinks && enumNow === before.enumVals), enumNow);

  console.log("-- new tables: RLS and grants");
  for (const t of NEW_TABLES) {
    const [r] = await q(`select c.relrowsecurity as rls,
        has_table_privilege('anon', c.oid, 'SELECT') as anon_sel,
        has_table_privilege('anon', c.oid, 'INSERT') or has_table_privilege('anon', c.oid, 'UPDATE') or has_table_privilege('anon', c.oid, 'DELETE') as anon_write,
        has_table_privilege('authenticated', c.oid, 'SELECT') as auth_sel,
        has_table_privilege('authenticated', c.oid, 'INSERT') as auth_ins,
        has_table_privilege('authenticated', c.oid, 'UPDATE') as auth_upd,
        has_table_privilege('authenticated', c.oid, 'DELETE') as auth_del,
        has_table_privilege('service_role', c.oid, 'SELECT') as svc_sel
      from pg_class c where c.oid = ('public.' || $1)::regclass`, [t]);
    const want = {
      cl_pay_link_settings: { auth_sel: true, auth_ins: false, auth_upd: true, auth_del: false },
      pay_links: { auth_sel: true, auth_ins: false, auth_upd: false, auth_del: false },
      pay_link_events: { auth_sel: true, auth_ins: false, auth_upd: false, auth_del: false },
      consent_records: { auth_sel: true, auth_ins: false, auth_upd: false, auth_del: false },
      pay_link_lookup_attempts: { auth_sel: false, auth_ins: false, auth_upd: false, auth_del: false },
    }[t];
    ok(`${t}: RLS on, anon nothing, authenticated ${JSON.stringify(want)}, service_role reads`,
      r.rls && !r.anon_sel && !r.anon_write && r.svc_sel &&
        Object.entries(want).every(([k, v]) => r[k] === v), r);
  }
  const [inv] = await q(`select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='invoices'`);
  ok("invoices gains exactly one column (pay_link_id)", inv.n === before.invoiceCols + 1 || before.payLinks, { before: before.invoiceCols, after: inv.n });

  console.log("-- function EXECUTE matrix");
  const fnMatrix = {
    "public.issue_pay_link(uuid)": "staff",
    "public.staff_create_pay_link_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,boolean,uuid)": "staff",
    "public.resolve_payment_attempt(uuid)": "staff",
    "public.pay_link_lookup(text,text)": "service",
    "public.pay_link_begin_charge(text,numeric,boolean)": "service",
    "public.pay_link_clear_charge(uuid,uuid)": "service",
    "public.record_pay_link_payment(uuid,uuid,text,numeric,boolean)": "service",
    "public.pay_link_due_events(date)": "service",
    "public.claim_pay_link_event(uuid,text,integer,date)": "service",
    "public.finish_pay_link_event(uuid,text,integer,text,text)": "service",
    "public.pay_link_staff_alert_recipients()": "service",
    "public.purge_pay_link_lookup_attempts()": "service",
    "public._pay_link_hash(text)": "internal",
    "public._issue_pay_link(uuid,uuid)": "internal",
    "public._assert_pay_link_issuable(uuid)": "internal",
    "public.end_pay_links_on_booking_change()": "internal",
    "public.validate_pay_link_settings()": "internal",
  };
  for (const [sig, kind] of Object.entries(fnMatrix)) {
    const [r] = await q(`select has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon,
        has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth,
        has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as svc,
        (select prosecdef from pg_proc where oid = $1::regprocedure) as definer,
        (select proconfig::text from pg_proc where oid = $1::regprocedure) as config`, [sig]);
    const expect = kind === "staff" ? !r.anon && r.auth : kind === "service" ? !r.anon && !r.auth && r.svc : !r.anon && !r.auth;
    ok(`${kind.padEnd(8)} ${sig.replace("public.", "").split("(")[0]}: anon=${r.anon} authenticated=${r.auth} service_role=${r.svc} definer=${r.definer}`,
      expect && r.config === "{search_path=public}", r.config);
  }

  console.log("-- settings defaults");
  const [s0] = await q(`select enabled, reminder_after_days, reminder_repeat, reminder_max, staff_alert_after_days,
                               staff_alert_user_id, staff_alert_each_reminder from public.cl_pay_link_settings`);
  ok("defaults: feature OFF, N=2, repeat off, max 3, M=3, no recipient, no per-reminder alert",
    s0.enabled === false && s0.reminder_after_days === 2 && s0.reminder_repeat === false && s0.reminder_max === 3 &&
      s0.staff_alert_after_days === 3 && s0.staff_alert_user_id === null && s0.staff_alert_each_reminder === false, s0);

  // --------------------------------------------------------------- fixtures
  console.log("-- throwaway accounts (exist only inside this transaction)");
  async function makeUser(who, role, hidden = false) {
    const [{ id }] = await q(`insert into auth.users (id, aud, role, email) values (gen_random_uuid(), 'authenticated', 'authenticated', $1) returning id`, [mail(who)]);
    await q(`delete from public.profiles where id = $1`, [id]);
    await q(`insert into public.profiles (id, role, full_name, hidden_from_users) values ($1, $2, $3, $4)`, [id, role, `Pay-link probe ${who}`, hidden]);
    return { id, claims: { sub: id, role: "authenticated", email: mail(who) } };
  }
  const staff = await makeUser("staff", "staff");
  const owner = await makeUser("owner", "owner");
  const hiddenOwner = await makeUser("hidden-owner", "owner", true);
  const customer = await makeUser("customer", "customer");
  const asStaff = (fn) => asRole("authenticated", staff.claims, fn);
  const asOwner = (fn) => asRole("authenticated", owner.claims, fn);
  const asCustomer = (fn) => asRole("authenticated", customer.claims, fn);
  const asAnon = (fn) => asRole("anon", { role: "anon" }, fn);
  const roles = await asStaff(() => q(`select public.is_staff() as s, public.is_owner() as o`));
  ok("throwaway staff is staff, not owner", roles[0].s && !roles[0].o);

  // Free units: (size, delivery date) pairs on days from the yard's day+5.
  const [{ today }] = await q(`select public.yard_today()::text as today`);
  const sizes = (await q(`select unnest(enum_range(null::dumpster_size))::text as s`)).map((r) => r.s);
  const pool = [];
  for (let d = 5; d < 90 && pool.length < 30; d += 3) {
    for (const s of sizes) {
      const [a] = await q(`select (public.yard_today() + $2::int)::text as day, total - committed as free, blocked
                             from public.size_availability($1::dumpster_size, public.yard_today() + $2::int, public.yard_today() + $2::int + 5, 5) limit 1`, [s, d]);
      if (!a.blocked && a.free >= 1) pool.push([s, a.day]);
    }
  }
  ok("found enough free (size, day) slots for the booking checks", pool.length >= 18, pool.length);
  const slot = () => pool.shift();
  const ADDR = "1 Probe St, Columbus, OH 43215";
  const ph = (n) => Array.from({ length: n }, (_, i) => `$${i + 1}`).join(", ");
  const staffBook = async (opts = {}) => {
    const [size, day] = slot();
    return asStaff(() => attempt(() => q(`select public.staff_create_booking(${ph(12)}) as id`,
      [size, day, ADDR, "PROBE staff", 5, null, null, opts.email ?? mail(`b${TAG}`), opts.phone ?? null, null, false, null])));
  };
  const payLinkBook = (opts) => {
    const [size, day] = slot();
    return asStaff(() => attempt(() => q(`select * from public.staff_create_pay_link_booking(${ph(12)})`,
      [size, day, ADDR, opts.name ?? "Probe Customer", 5, null, null, opts.email ?? null, opts.phone ?? null, null, opts.consent ?? false, null])));
  };

  // ------------------------------------------- current production paths
  console.log("-- current production code paths still work after the migration");
  {
    const [size, day] = slot();
    const cb = await sAttempt(`select public.create_booking(${ph(10)}) as id`, [size, day, ADDR, "PROBE online", 5, null, null, mail("online"), null, null]);
    ok("service_role create_booking (online /book)", cb.ok, cb.ok ? "booked" : cb.message);
    if (cb.ok) {
      const id = cb.value[0].id;
      const total = (await q(`select total from public.bookings where id = $1`, [id]))[0].total;
      const rp = await sAttempt(`select payment_status from public.record_payment($1, 'probe-charge-online', null, $2)`, [id, total]);
      ok("service_role record_payment marks it paid (card)", rp.ok && rp.value[0].payment_status === "paid", rp.ok ? rp.value[0] : rp.message);
      const cr = await asStaff(() => attempt(() => q(`select status, payment_status from public.cancel_and_refund($1, 'probe-refund', 'void', $2)`, [id, total])));
      ok("staff cancel_and_refund on the card-paid booking", cr.ok && cr.value[0]?.status === "cancelled", cr.ok ? cr.value[0] : cr.message);
    }
    const sb = await staffBook();
    ok("authenticated staff staff_create_booking (unchanged staff path)", sb.ok, sb.ok ? "booked" : sb.message);
    if (sb.ok) {
      const mp = await asStaff(() => attempt(() => q(`select payment_status from public.record_manual_payment($1, 'check', '1234', 'probe')`, [sb.value[0].id])));
      ok("staff record_manual_payment (check)", mp.ok && mp.value[0].payment_status === "paid", mp.ok ? mp.value[0] : mp.message);
    }
    const sb2 = await staffBook();
    if (sb2.ok) {
      const ii = await asStaff(() => attempt(() => q(`select payment_status from public.record_invoice_issued($1, 'probe-qbo-1', null, $2)`, [sb2.value[0].id, mail("qbo")])));
      ok("staff record_invoice_issued (QuickBooks pay-link invoice)", ii.ok, ii.ok ? "recorded" : ii.message);
      const det = await sAttempt(`select public.record_invoice_payment_detected($1, 'probe-qbo-1', 'probe-pay-1') as flipped`, [sb2.value[0].id]);
      ok("service_role record_invoice_payment_detected flips it paid", det.ok && det.value[0].flipped === true, det.ok ? det.value[0] : det.message);
    }
    const sb3 = await staffBook();
    if (sb3.ok) {
      const cx = await asStaff(() => attempt(() => q(`select status from public.set_booking_status($1, 'cancelled')`, [sb3.value[0].id])));
      ok("staff set_booking_status -> cancelled", cx.ok && cx.value[0].status === "cancelled", cx.ok ? cx.value[0] : cx.message);
    }
  }

  // ------------------------------------------------------- feature off
  console.log("-- feature OFF (the default)");
  const offCreate = await payLinkBook({ email: mail("off") });
  ok("staff_create_pay_link_booking refuses while off (pay_links_disabled)", !offCreate.ok && offCreate.hint === "pay_links_disabled", offCreate.hint ?? offCreate.message);

  // ------------------------------------------------------------- settings
  console.log("-- settings: only an owner writes; the recipient must be an active, visible staff/owner");
  const staffUpd = await asStaff(() => attempt(async () => (await c.query(`update public.cl_pay_link_settings set enabled = true`)).rowCount));
  ok("staff update changes nothing (RLS: owner only)", staffUpd.ok && staffUpd.value === 0, staffUpd.ok ? staffUpd.value : staffUpd.message);
  const custRead = await asCustomer(() => attempt(() => q(`select * from public.cl_pay_link_settings`)));
  ok("a customer session reads no settings row", custRead.ok && custRead.value.length === 0, custRead.ok ? custRead.value.length : custRead.message);
  const anonRead = await asAnon(() => attempt(() => q(`select * from public.cl_pay_link_settings`)));
  ok("anon cannot read settings (42501)", !anonRead.ok && anonRead.code === "42501", anonRead.code);
  const setHidden = await asOwner(() => attempt(() => q(`update public.cl_pay_link_settings set staff_alert_user_id = $1`, [hiddenOwner.id])));
  ok("owner cannot choose a hidden account as the alert recipient (bad_alert_user)", !setHidden.ok && setHidden.hint === "bad_alert_user", setHidden.hint ?? setHidden.message);
  const setCust = await asOwner(() => attempt(() => q(`update public.cl_pay_link_settings set staff_alert_user_id = $1`, [customer.id])));
  ok("owner cannot choose a customer as the alert recipient", !setCust.ok && setCust.hint === "bad_alert_user", setCust.hint ?? setCust.message);
  const badN = await asOwner(() => attempt(() => q(`update public.cl_pay_link_settings set reminder_after_days = 0`)));
  ok("reminder interval 0 is refused (check 1-30)", !badN.ok && badN.code === "23514", badN.code);
  const badMax = await asOwner(() => attempt(() => q(`update public.cl_pay_link_settings set reminder_max = 11`)));
  ok("reminder maximum 11 is refused (check 1-10)", !badMax.ok && badMax.code === "23514", badMax.code);
  const enable = await asOwner(() => attempt(async () => (await c.query(
    `update public.cl_pay_link_settings set enabled = true, staff_alert_user_id = $1, updated_by = auth.uid()`, [staff.id])).rowCount));
  ok("owner turns the feature on and picks the throwaway staff as recipient", enable.ok && enable.value === 1, enable.ok ? enable.value : enable.message);

  // -------------------------------------------------------- contact rule
  console.log("-- Book with a pay link: contact rule, consent record, token");
  const noContact = await payLinkBook({ phone: "6145550111", consent: false });
  ok("phone without verbal consent and no email is refused (no_reachable_contact)", !noContact.ok && noContact.hint === "no_reachable_contact", noContact.hint ?? noContact.message);
  const nothing = await payLinkBook({});
  ok("no email and no phone is refused", !nothing.ok && nothing.hint === "no_reachable_contact", nothing.hint ?? nothing.message);
  const phoneOnly = await payLinkBook({ phone: "6145550112", consent: true, name: "Pat Phone" });
  ok("phone + verbal consent books and returns a link", phoneOnly.ok && !!phoneOnly.value[0]?.token, phoneOnly.ok ? "ok" : phoneOnly.message);
  const P = phoneOnly.value[0];
  const [cr1] = await q(`select cr.granted, cr.source, cr.recorded_by::text as by, cr.channel, cr.booking_id::text as booking,
                                c.sms_consent from public.consent_records cr join public.customers c on c.id = cr.customer_id
                          where cr.booking_id = $1`, [P.booking_id]);
  ok("  ...consent record: sms, granted, phone_verbal, by the staff member, for this booking; customer flag on",
    cr1 && cr1.granted && cr1.source === "phone_verbal" && cr1.by === staff.id && cr1.channel === "sms" && cr1.booking === P.booking_id && cr1.sms_consent, cr1);
  ok("  ...token is 43 chars of base64url", /^[A-Za-z0-9_-]{43}$/.test(P.token), P.token.length);
  const [stored] = await q(`select encode(token_hash, 'hex') as h, row_to_json(l)::text as row from public.pay_links l where booking_id = $1`, [P.booking_id]);
  ok("  ...only the SHA-256 is stored; the token text appears nowhere in the row",
    stored.h === crypto.createHash("sha256").update(P.token).digest("hex") && !stored.row.includes(P.token));
  const emailOnly = await payLinkBook({ email: mail("cust1"), name: "Erin Email" });
  ok("email only (no consent) books and returns a link", emailOnly.ok, emailOnly.ok ? "ok" : emailOnly.message);
  const E = emailOnly.value[0];
  const [noRec] = await q(`select count(*)::int as n from public.consent_records where booking_id = $1`, [E.booking_id]);
  ok("  ...no consent record when the box wasn't ticked", noRec.n === 0, noRec.n);

  const custCreate = await asCustomer(() => attempt(() => q(`select * from public.staff_create_pay_link_booking('10yd', $1::date, 'x', 'x', 5, null, null, $2, null, null, false, null)`, [pool[0][1], mail("x")])));
  ok("a customer session cannot book with a pay link (42501)", !custCreate.ok && custCreate.code === "42501", custCreate.code);

  // ----------------------------------------------------------------- lookup
  console.log("-- public lookup (service_role)");
  const look = async (token, key = `probe-key-${TAG}`) => (await sAttempt(`select public.pay_link_lookup($1, $2) as r`, [token, key])).value?.[0]?.r;
  const L1 = await look(E.token);
  const [eb] = await q(`select total, subtotal, tax, delivery_date::text as d from public.bookings where id = $1`, [E.booking_id]);
  ok("active link: first name, size, dates, address, subtotal/tax/total from the saved booking",
    L1?.state === "active" && L1.first_name === "Erin" && L1.total === eb.total && L1.subtotal === eb.subtotal && L1.tax === eb.tax && L1.delivery_date === eb.d && L1.delivery_address === ADDR, L1);
  ok("  ...and nothing else: no email, phone, full name, notes or customer id",
    L1 && Object.keys(L1).sort().join() === "booking_id,delivery_address,delivery_date,first_name,link_id,pickup_date,size,state,subtotal,tax,total", Object.keys(L1 ?? {}));
  ok("a wrong token is not_found", (await look("x".repeat(43)))?.state === "not_found");
  const anonLook = await asAnon(() => attempt(() => q(`select public.pay_link_lookup($1, 'k')`, [E.token])));
  ok("anon cannot call the lookup (42501)", !anonLook.ok && anonLook.code === "42501", anonLook.code);
  const staffLook = await asStaff(() => attempt(() => q(`select public.pay_link_lookup($1, 'k')`, [E.token])));
  ok("staff cannot call the lookup (42501)", !staffLook.ok && staffLook.code === "42501", staffLook.code);
  const custLinks = await asCustomer(() => attempt(() => q(`select * from public.pay_links`)));
  ok("a customer session reads no pay_links rows", custLinks.ok && custLinks.value.length === 0);
  const anonLinks = await asAnon(() => attempt(() => q(`select * from public.pay_links`)));
  ok("anon cannot read pay_links (42501)", !anonLinks.ok && anonLinks.code === "42501", anonLinks.code);
  const staffLinks = await asStaff(() => attempt(() => q(`select count(*)::int as n from public.pay_links`)));
  ok("staff can read pay_links", staffLinks.ok && staffLinks.value[0].n >= 2);

  console.log("-- rate limit");
  const missKey = `probe-miss-${TAG}`;
  for (let i = 0; i < 10; i++) await look(`wrong-${i}`.padEnd(43, "x"), missKey);
  ok("after 10 misses the 11th lookup is throttled, even with the right token", (await look(E.token, missKey))?.state === "throttled");
  const hitKey = `probe-hit-${TAG}`;
  for (let i = 0; i < 30; i++) await look(E.token, hitKey);
  ok("after 30 lookups the 31st is throttled", (await look(E.token, hitKey))?.state === "throttled");
  ok("another client is unaffected", (await look(E.token, `probe-other-${TAG}`))?.state === "active");

  // ----------------------------------------------------------------- resend
  console.log("-- resend replaces the link");
  const re = await asStaff(() => attempt(() => q(`select public.issue_pay_link($1) as token`, [E.booking_id])));
  ok("staff issue_pay_link (resend) returns a new token", re.ok && re.value[0].token !== E.token, re.ok ? "ok" : re.message);
  const E2 = re.value[0].token;
  ok("  ...the old token is dead (not_found)", (await look(E.token, `probe-r-${TAG}`))?.state === "not_found");
  ok("  ...the new token is active", (await look(E2, `probe-r-${TAG}`))?.state === "active");
  const [act] = await q(`select count(*) filter (where status = 'active')::int as active, count(*) filter (where status = 'superseded')::int as superseded from public.pay_links where booking_id = $1`, [E.booking_id]);
  ok("  ...exactly one active, one superseded", act.active === 1 && act.superseded === 1, act);
  const dup = await attempt(() => q(`insert into public.pay_links (booking_id, token_hash) values ($1, '\\x00')`, [E.booking_id]));
  ok("the unique index refuses a second active link even outside the RPCs", !dup.ok && dup.code === "23505", dup.code);

  console.log("-- issuing refuses while a QuickBooks invoice is pending");
  const qb = await staffBook();
  await asStaff(() => q(`select public.record_invoice_issued($1, 'probe-qbo-2', null, $2)`, [qb.value[0].id, mail("qbo2")]));
  const qbIssue = await asStaff(() => attempt(() => q(`select public.issue_pay_link($1)`, [qb.value[0].id])));
  ok("issue_pay_link refuses (qbo_invoice_pending)", !qbIssue.ok && qbIssue.hint === "qbo_invoice_pending", qbIssue.hint ?? qbIssue.message);

  // ------------------------------------------------------------ charge flow
  console.log("-- begin charge / record payment (service_role)");
  const begin = async (token, total, agree = true) =>
    (await sAttempt(`select public.pay_link_begin_charge($1, $2, $3) as r`, [token, total, agree])).value?.[0]?.r;
  ok("no agreement tick -> no_agreement", (await begin(E2, eb.total, false))?.state === "no_agreement");
  const changed = await begin(E2, eb.total + 1);
  ok("a stale total -> amount_changed with the saved total", changed?.state === "amount_changed" && changed.total === eb.total, changed);
  const b1 = await begin(E2, eb.total);
  ok("ok: request id and the saved total", b1?.state === "ok" && b1.amount === eb.total && /^[0-9a-f-]{36}$/.test(b1.request_id), b1);
  ok("a second click within 2 minutes -> in_progress", (await begin(E2, eb.total))?.state === "in_progress");
  const [ack1] = await q(`select agreement_ack_at is not null as acked from public.pay_links where id = $1`, [b1.link_id]);
  ok("  ...the agreement time is stored on this link", ack1.acked);
  await svc(() => q(`select public.pay_link_clear_charge($1, $2)`, [b1.link_id, b1.request_id]));
  const b2 = await begin(E2, eb.total);
  ok("after a decline (clear_charge) a retry gets a NEW request id", b2?.state === "ok" && b2.request_id !== b1.request_id, b2?.state);
  const rec = async (linkId, reqId, charge, amount, optIn = false) =>
    (await sAttempt(`select public.record_pay_link_payment($1, $2, $3, $4, $5) as r`, [linkId, reqId, charge, amount, optIn])).value?.[0]?.r;
  ok("record with the OLD request id -> refused_link", (await rec(b2.link_id, b1.request_id, "probe-charge-x", eb.total)) === "refused_link");
  ok("record with the wrong amount -> refused_amount", (await rec(b2.link_id, b2.request_id, "probe-charge-x", eb.total - 1)) === "refused_amount");
  ok("record with the live request id -> recorded", (await rec(b2.link_id, b2.request_id, "probe-charge-1", eb.total, true)) === "recorded");
  ok("record again with the same charge -> already_recorded", (await rec(b2.link_id, b2.request_id, "probe-charge-1", eb.total)) === "already_recorded");
  ok("a different charge on the paid booking -> refused_paid", (await rec(b2.link_id, b2.request_id, "probe-charge-2", eb.total)) === "refused_paid");
  const [paid] = await q(`select b.payment_status, i.status as inv, i.payment_method, i.qb_charge_id, i.amount, i.sync_status,
                                 i.pay_link_id::text as inv_link, l.status as link, l.paid_at is not null as link_paid_at,
                                 l.agreement_ack_at is not null and l.agreement_ack_at <= l.paid_at as ack_before_pay,
                                 c.sms_consent
                            from public.bookings b join public.invoices i on i.booking_id = b.id
                            join public.pay_links l on l.id = $2 join public.customers c on c.id = b.customer_id
                           where b.id = $1`, [E.booking_id, b2.link_id]);
  ok("booking paid; invoice paid by card with the charge, amount, pending sync and THIS link; link paid; agreement before payment",
    paid.payment_status === "paid" && paid.inv === "paid" && paid.payment_method === "card" && paid.qb_charge_id === "probe-charge-1" &&
      paid.amount === eb.total && paid.sync_status === "pending" && paid.inv_link === b2.link_id && paid.link === "paid" && paid.link_paid_at && paid.ack_before_pay, paid);
  const [optIn] = await q(`select source, granted, recorded_by, pay_link_id::text as link from public.consent_records where booking_id = $1`, [E.booking_id]);
  ok("  ...pay-page 'text me updates' stored with its own record, the link, no staff actor; customer flag on",
    optIn?.source === "pay_page" && optIn.granted && optIn.recorded_by === null && optIn.link === b2.link_id && paid.sms_consent, optIn);
  ok("the paid link now looks up as 'paid'", (await look(E2, `probe-p-${TAG}`))?.state === "paid");
  ok("begin on a paid link -> paid", (await begin(E2, eb.total))?.state === "paid");
  const cardCancel = await asStaff(() => attempt(() => q(`select status from public.cancel_and_refund($1, 'probe-refund-2', 'void', $2)`, [E.booking_id, eb.total])));
  ok("staff Cancel & refund works on a pay-link payment (it is a normal card payment)", cardCancel.ok, cardCancel.ok ? "ok" : cardCancel.message);

  // ------------------------------------------------------------ the trigger
  console.log("-- other paths end the link");
  const t1 = await payLinkBook({ email: mail("t1") });
  await asStaff(() => q(`select public.record_manual_payment($1, 'cash', null, null)`, [t1.value[0].booking_id]));
  const [e1] = await q(`select status, ended_reason, ended_at is not null as ended from public.pay_links where booking_id = $1`, [t1.value[0].booking_id]);
  ok("cash recorded -> link ended (paid_other_path)", e1.status === "ended" && e1.ended_reason === "paid_other_path" && e1.ended, e1);
  ok("  ...and its token is dead", (await look(t1.value[0].token, `probe-t-${TAG}`))?.state === "not_found");

  const t2 = await payLinkBook({ email: mail("t2") });
  const [t2b] = await q(`select total from public.bookings where id = $1`, [t2.value[0].booking_id]);
  const t2begin = await begin(t2.value[0].token, t2b.total);
  await asStaff(() => q(`select public.set_booking_status($1, 'cancelled')`, [t2.value[0].booking_id]));
  const [e2] = await q(`select status, ended_reason from public.pay_links where booking_id = $1`, [t2.value[0].booking_id]);
  ok("cancelled -> link ended (booking_cancelled)", e2.status === "ended" && e2.ended_reason === "booking_cancelled", e2);
  ok("a charge captured after the cancel is refused (refused_cancelled) so the action refunds it",
    (await rec(t2begin.link_id, t2begin.request_id, "probe-charge-3", t2b.total)) === "refused_cancelled");
  const reissue = await asStaff(() => attempt(() => q(`select public.issue_pay_link($1)`, [t2.value[0].booking_id])));
  ok("no new link for a cancelled booking (not_open)", !reissue.ok && reissue.hint === "not_open", reissue.hint ?? reissue.message);

  // ---------------------------------------------------- schedule (yard day)
  console.log("-- reminders and staff alerts in yard days, across the Nov 1 change");
  const due = async (day) => (await svc(() => q(`select booking_id::text, kind, seq from public.pay_link_due_events($1::date)`, [day])));
  const dueFor = async (id, day) => (await due(day)).filter((r) => r.booking_id === id).map((r) => `${r.kind}#${r.seq}`).sort();
  const sA = await payLinkBook({ email: mail("sa") });
  const sB = await payLinkBook({ email: mail("sb") });
  const A = sA.value[0].booking_id, B = sB.value[0].booking_id;
  // A: made 11:30 PM EDT Sat Oct 31 (UTC is already Nov 1). B: 11:30 PM EST Sun Nov 1 (UTC Nov 2).
  await q(`update public.bookings set created_at = '2026-11-01T03:30:00Z', delivery_date = '2026-11-06', pickup_date = '2026-11-11' where id = $1`, [A]);
  await q(`update public.bookings set created_at = '2026-11-02T04:30:00Z', delivery_date = '2026-11-03', pickup_date = '2026-11-08' where id = $1`, [B]);
  ok("A (made Oct 31 yard / Nov 1 UTC): nothing on Nov 1", (await dueFor(A, "2026-11-01")).length === 0);
  ok("A: first reminder on Nov 2 (UTC would say Nov 3)", JSON.stringify(await dueFor(A, "2026-11-02")) === '["customer_reminder#1"]', await dueFor(A, "2026-11-02"));
  ok("A: staff alert from Nov 3 (M=3)", (await dueFor(A, "2026-11-03")).includes("staff_alert#1"), await dueFor(A, "2026-11-03"));
  ok("B (made Nov 1 yard / Nov 2 UTC): nothing on Nov 2", (await dueFor(B, "2026-11-02")).length === 0);
  ok("B: first reminder on Nov 3 = its delivery day (UTC would say Nov 4)", JSON.stringify(await dueFor(B, "2026-11-03")) === '["customer_reminder#1"]', await dueFor(B, "2026-11-03"));
  ok("B: no reminder after the delivery date (Nov 4: staff alert only)", JSON.stringify(await dueFor(B, "2026-11-04")) === '["staff_alert#1"]', await dueFor(B, "2026-11-04"));

  // The default p_today is yard_today(): pin the clock to 11:30 PM EST Mon Nov 2 (UTC Nov 3).
  await q(`create or replace function public.yard_today(p_now timestamptz default now())
    returns date language sql stable set search_path = public
    as $$ select (timestamptz '2026-11-03T04:30:00Z' at time zone 'America/New_York')::date $$`);
  const dflt = (await svc(() => q(`select booking_id::text, kind, seq from public.pay_link_due_events()`))).filter((r) => r.booking_id === A).map((r) => `${r.kind}#${r.seq}`);
  ok("with no date, the cron uses the yard's day (Nov 2 at 11:30 PM EST): A's reminder #1, no staff alert yet", JSON.stringify(dflt) === '["customer_reminder#1"]', dflt);

  const claim = async (id, kind, seq, day) => (await sAttempt(`select public.claim_pay_link_event($1, $2, $3, $4::date) as c`, [id, kind, seq, day])).value?.[0]?.c;
  ok("claim A reminder #1 -> true", (await claim(A, "customer_reminder", 1, "2026-11-02")) === true);
  ok("claim it again (a cron re-run) -> false", (await claim(A, "customer_reminder", 1, "2026-11-02")) === false);
  ok("  ...and it's no longer listed as due", !(await dueFor(A, "2026-11-02")).includes("customer_reminder#1"));
  await svc(() => q(`select public.finish_pay_link_event($1, 'customer_reminder', 1, 'sent', null)`, [A]));
  const [fin] = await q(`select status, completed_at is not null as done from public.pay_link_events where booking_id = $1 and kind = 'customer_reminder' and seq = 1`, [A]);
  ok("finish marks it sent", fin.status === "sent" && fin.done, fin);
  ok("repeat OFF: no second reminder on Nov 4", !(await dueFor(A, "2026-11-04")).some((k) => k.startsWith("customer_reminder")), await dueFor(A, "2026-11-04"));
  await asOwner(() => q(`update public.cl_pay_link_settings set reminder_repeat = true, reminder_max = 3`));
  ok("repeat ON: reminder #2 on Nov 4", (await dueFor(A, "2026-11-04")).includes("customer_reminder#2"), await dueFor(A, "2026-11-04"));
  ok("missed days are skipped, not burst: on Nov 6 only #3 is due", JSON.stringify((await dueFor(A, "2026-11-06")).filter((k) => k.startsWith("customer"))) === '["customer_reminder#3"]', await dueFor(A, "2026-11-06"));
  await q(`update public.bookings set delivery_date = '2026-11-20', pickup_date = '2026-11-25' where id = $1`, [A]);
  await claim(A, "customer_reminder", 3, "2026-11-06");
  ok("never more than the maximum (3) even weeks later", !(await dueFor(A, "2026-11-19")).some((k) => k.startsWith("customer")), await dueFor(A, "2026-11-19"));
  await asOwner(() => q(`update public.cl_pay_link_settings set enabled = false`));
  ok("feature OFF: nothing is due", (await due("2026-11-04")).length === 0);
  const offLook = await look(sA.value[0].token, `probe-off-${TAG}`);
  ok("feature OFF: an existing link still looks up as active (still payable)", offLook?.state === "active", offLook?.state);
  const offIssue = await asStaff(() => attempt(() => q(`select public.issue_pay_link($1)`, [A])));
  ok("feature OFF: no new or resent links (pay_links_disabled)", !offIssue.ok && offIssue.hint === "pay_links_disabled", offIssue.hint);
  await asOwner(() => q(`update public.cl_pay_link_settings set enabled = true`));
  await asStaff(() => q(`select public.set_booking_status($1, 'cancelled')`, [B]));
  ok("cancelled booking: nothing due, and a claim is refused", !(await due("2026-11-04")).some((r) => r.booking_id === B) && (await claim(B, "staff_alert", 1, "2026-11-04")) === false);

  // -------------------------------------------------- alert recipients
  console.log("-- staff-alert recipients");
  const recips = async () => svc(() => q(`select profile_id::text, email, via_fallback from public.pay_link_staff_alert_recipients()`));
  const r1 = await recips();
  ok("chosen staff member is the only recipient, not a fallback", r1.length === 1 && r1[0].profile_id === staff.id && r1[0].via_fallback === false, r1);
  await q(`update public.profiles set removed_at = now() where id = $1`, [staff.id]);
  const r2 = await recips();
  const hiddenIds = (await q(`select id::text from public.profiles where hidden_from_users`)).map((r) => r.id);
  ok("chosen user removed -> every visible owner, flagged as fallback", r2.length >= 1 && r2.every((r) => r.via_fallback) && r2.some((r) => r.profile_id === owner.id), { recipients: r2.length });
  ok("  ...hidden owners (the throwaway one and the seed owner) are never in the fallback",
    !r2.some((r) => hiddenIds.includes(r.profile_id)) && !r2.some((r) => r.email === "seed-owner@crazylarrys.test") && hiddenIds.includes(hiddenOwner.id));
  const custR = await asCustomer(() => attempt(() => q(`select * from public.pay_link_staff_alert_recipients()`)));
  ok("a customer session cannot list recipients (42501)", !custR.ok && custR.code === "42501", custR.code);

  // ---------------------------------------------------- needs-action
  console.log("-- needs-action: a failed compensating refund");
  await svc(() => q(`select public.record_payment_attempt('compensating_refund', 'probe-charge-9', null, 1.00, null, 'probe', '{"refund_succeeded": false}'::jsonb)`));
  const [pa] = await q(`select id from public.payment_attempts where qb_charge_id = 'probe-charge-9'`);
  const custRes = await asCustomer(() => attempt(() => q(`select public.resolve_payment_attempt($1)`, [pa.id])));
  ok("a customer cannot resolve it (42501)", !custRes.ok && custRes.code === "42501", custRes.code);
  const res1 = await asOwner(() => attempt(() => q(`select public.resolve_payment_attempt($1)`, [pa.id])));
  const [pa2] = await q(`select resolved_at is not null as r, resolved_by::text as by from public.payment_attempts where id = $1`, [pa.id]);
  ok("staff resolve it: time and who are stored", res1.ok && pa2.r && pa2.by === owner.id, res1.ok ? pa2 : res1.message);
  const res2 = await asOwner(() => attempt(() => q(`select public.resolve_payment_attempt($1)`, [pa.id])));
  ok("resolving it twice is refused (P0002)", !res2.ok && res2.code === "P0002", res2.code);

  // ---------------------------------------------- notifications_log scan
  console.log("-- token scan over notifications_log (the (c) test uses the same query)");
  const SCAN = `
    with cand as (
      select n.id, m[1] as token
        from public.notifications_log n,
             regexp_matches(coalesce(n.body, '') || ' ' || coalesce(n.error, ''), '/pay/([A-Za-z0-9_-]{43})', 'g') m
    )
    select cand.id::text, l.status from cand
      join public.pay_links l on l.token_hash = public._pay_link_hash(cand.token)
     where l.status = 'active'`;
  const live0 = await q(SCAN);
  ok("no live token in notifications_log now", live0.length === 0, live0.length);
  const tk = (await payLinkBook({ email: mail("scan") })).value[0];
  await q(`insert into public.notifications_log (booking_id, type, channel, recipient, delivery_status, body)
           values ($1, 'booking_confirmation', 'email', $2, 'skipped', $3)`, [tk.booking_id, mail("scan"), `Pay here: https://app.example/pay/${tk.token}`]);
  const live1 = await q(SCAN);
  ok("a planted live token IS caught by the scan (positive control)", live1.length === 1, live1.length);
} finally {
  await c.query("rollback");
}

const after = await snapshot();
console.log("AFTER ROLLBACK", JSON.stringify({ counts: after.counts, pay_links_exists: after.payLinks, bookings_triggers: after.triggers, notification_types: after.enumVals }));
ok("every existing function's md5 and ACL identical before and after",
  EXISTING.every((s) => JSON.stringify(after.fns[s]) === JSON.stringify(before.fns[s])));
ok("schema identical before and after (pay_links, bookings triggers, notification types, invoices columns)",
  after.payLinks === before.payLinks && after.triggers === before.triggers && after.enumVals === before.enumVals && after.invoiceCols === before.invoiceCols);
ok("row counts identical before and after; no probe user left",
  JSON.stringify(after.counts) === JSON.stringify(before.counts) && after.counts.probe_users === 0);
await c.end();
console.log(failures ? `\n${failures} FAILED (rolled back)` : "\nALL PASS (rolled back)");
process.exit(failures ? 1 : 0);
