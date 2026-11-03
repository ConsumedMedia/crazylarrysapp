// Rolled-back probe for supabase/migrations/20261103010000_pay_link_token_encrypted.sql.
//
//   node scripts/probe-pay-link-token.mjs     (repo root; reads DATABASE_URL from .env.local)
//
// ONE transaction, always rolled back: the migration, throwaway staff/owner/
// customer accounts, the feature switched on, bookings, links, payments.
// Nothing persists and nothing is sent. 20261103000000 must already be applied.
// The migration locks pay_links (and the probe's bookings writes lock a few
// rows) for the seconds this runs; lock_timeout stops it queueing.
//
// It checks:
//   - only the three issuing functions change; every other pay-link and
//     booking function keeps its md5 and ACL; the old signatures are gone
//   - token_encrypted: nullable, service_role reads it, staff/customer/anon
//     can't (42501), staff still read every other column
//   - issue with a key stores an AES-256 pgp message that decrypts to the
//     exact token; issue without a key stores nothing; one-arg calls still work
//   - the stored copy is cleared on resend, payment, cash, cancel and any
//     direct status change; the check constraint refuses a copy on a dead link
//   - pay_link_reminder_token: ok / no_key / no_link / no_stored_token /
//     decrypt_failed (wrong key)
//   - decrypt-and-send + log scan: a row logged the way notify.ts logs it
//     (token redacted) is clean; a raw token is caught
//   - pay_link_live_counts for staff, refused for customers
//   - after ROLLBACK every md5, ACL, column and row count matches the start
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

const MIGRATION = "supabase/migrations/20261103010000_pay_link_token_encrypted.sql";
const TAG = crypto.randomUUID().slice(0, 8);
const KEY = `probe-key-${crypto.randomBytes(24).toString("base64url")}`;
const mail = (who) => `pay-token-probe-${TAG}-${who}@example.com`;

const url = fs.readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, "");
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => Number(v));
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const q = async (sql, params) => (await c.query(sql, params)).rows;
let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
  if (!cond) failures++;
};

const UNCHANGED = [
  "public._pay_link_hash(text)",
  "public._assert_pay_link_issuable(uuid)",
  "public.pay_link_lookup(text,text)",
  "public.pay_link_begin_charge(text,numeric,boolean)",
  "public.pay_link_clear_charge(uuid,uuid)",
  "public.record_pay_link_payment(uuid,uuid,text,numeric,boolean)",
  "public.pay_link_due_events(date)",
  "public.claim_pay_link_event(uuid,text,integer,date)",
  "public.finish_pay_link_event(uuid,text,integer,text,text)",
  "public.pay_link_staff_alert_recipients()",
  "public.resolve_payment_attempt(uuid)",
  "public.purge_pay_link_lookup_attempts()",
  "public.end_pay_links_on_booking_change()",
  "public.validate_pay_link_settings()",
  "public._create_booking_core(dumpster_size,date,text,text,integer,text,text,text,text,text,uuid,boolean,uuid,text,uuid,uuid)",
  "public.create_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,uuid,boolean,uuid)",
  "public.staff_create_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,boolean,uuid)",
  "public.record_payment(uuid,text,text,numeric)",
  "public.record_manual_payment(uuid,text,text,text)",
  "public.set_booking_status(uuid,booking_status)",
  "public.cancel_and_refund(uuid,text,text,numeric)",
];
const OLD = [
  "public.issue_pay_link(uuid)",
  "public._issue_pay_link(uuid,uuid)",
  "public.staff_create_pay_link_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,boolean,uuid)",
];
const NEW = {
  "public.issue_pay_link(uuid,text)": "staff",
  "public.staff_create_pay_link_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,boolean,uuid,text)": "staff",
  "public.pay_link_live_counts()": "staff",
  "public.pay_link_reminder_token(uuid,text)": "service",
  "public._issue_pay_link(uuid,uuid,text)": "internal",
  "public.clear_pay_link_token()": "internal",
};

const fnAttrs = async (sig) =>
  (await q(`select md5(pg_get_functiondef(p.oid)) as md5, p.proacl::text as acl from pg_proc p where p.oid = to_regprocedure($1)`, [sig]))[0] ?? null;

async function snapshot() {
  await c.query("begin transaction read only");
  try {
    const fns = {};
    for (const s of [...UNCHANGED, ...OLD, ...Object.keys(NEW)]) fns[s] = await fnAttrs(s);
    const counts = (await q(`select
      (select count(*)::int from public.bookings) as bookings,
      (select count(*)::int from public.customers) as customers,
      (select count(*)::int from public.invoices) as invoices,
      (select count(*)::int from public.pay_links) as pay_links,
      (select count(*)::int from public.consent_records) as consent_records,
      (select count(*)::int from public.notifications_log) as notifications_log,
      (select count(*)::int from public.payment_attempts) as payment_attempts,
      (select count(*)::int from public.profiles) as profiles,
      (select count(*)::int from auth.users) as auth_users,
      (select count(*)::int from auth.users where email like 'pay-token-probe-%') as probe_users,
      (select count(*)::int from supabase_migrations.schema_migrations) as migrations`))[0];
    const cols = (await q(`select string_agg(column_name, ',' order by ordinal_position) as c from information_schema.columns
                            where table_schema = 'public' and table_name = 'pay_links'`))[0].c;
    const acl = (await q(`select relacl::text as a from pg_class where oid = 'public.pay_links'::regclass`))[0].a;
    const settings = (await q(`select row_to_json(s)::text as s from public.cl_pay_link_settings s`))[0].s;
    return { fns, counts, cols, acl, settings };
  } finally {
    await c.query("rollback");
  }
}
async function attempt(fn) {
  await c.query("savepoint a");
  try {
    const v = await fn();
    await c.query("release savepoint a");
    return { ok: true, value: v };
  } catch (e) {
    await c.query("rollback to savepoint a");
    return { ok: false, code: e.code, message: e.message, hint: e.hint };
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

await c.connect();
const before = await snapshot();
console.log("BEFORE", JSON.stringify({ counts: before.counts, pay_links_columns: before.cols }));
if (!before.fns["public.issue_pay_link(uuid)"]) throw new Error("20261103000000 must be applied first (issue_pay_link(uuid) not found)");
if (before.cols.includes("token_encrypted")) console.log("NOTE  token_encrypted already exists: this migration looks applied.");

try {
  await c.query("begin");
  await c.query("set local lock_timeout = '5s'");
  await c.query("set local statement_timeout = '60s'");
  await c.query(fs.readFileSync(MIGRATION, "utf8"));
  ok("migration runs cleanly inside the transaction", true);

  console.log("-- what changed and what didn't");
  for (const s of UNCHANGED) {
    const a = await fnAttrs(s);
    ok(`unchanged: ${s.replace("public.", "").split("(")[0]}`, !!a && a.md5 === before.fns[s]?.md5 && a.acl === before.fns[s]?.acl);
  }
  for (const s of OLD) ok(`old signature dropped: ${s.replace("public.", "")}`, (await fnAttrs(s)) === null);
  for (const [s, kind] of Object.entries(NEW)) {
    const [r] = await q(`select has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon,
        has_function_privilege('public', $1::regprocedure, 'EXECUTE') as pub,
        has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth,
        has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as svc,
        (select proconfig::text from pg_proc where oid = $1::regprocedure) as config`, [s]);
    const good = !r.anon && !r.pub && r.config === "{search_path=public}" &&
      (kind === "staff" ? r.auth : !r.auth) && (kind !== "service" || r.svc);
    ok(`${kind.padEnd(8)} ${s.replace("public.", "").split("(")[0]}: anon=${r.anon} authenticated=${r.auth} service_role=${r.svc}`, good);
  }

  console.log("-- the column and who can read it");
  const [col] = await q(`select is_nullable, data_type,
      has_column_privilege('authenticated', 'public.pay_links', 'token_encrypted', 'SELECT') as auth_sel,
      has_column_privilege('anon', 'public.pay_links', 'token_encrypted', 'SELECT') as anon_sel,
      has_column_privilege('service_role', 'public.pay_links', 'token_encrypted', 'SELECT') as svc_sel,
      has_column_privilege('authenticated', 'public.pay_links', 'status', 'SELECT') as auth_status
    from information_schema.columns where table_schema = 'public' and table_name = 'pay_links' and column_name = 'token_encrypted'`);
  ok("token_encrypted is a nullable bytea", col?.is_nullable === "YES" && col.data_type === "bytea", col);
  ok("column privilege: service_role yes; authenticated and anon no; authenticated still reads status",
    col.svc_sel && !col.auth_sel && !col.anon_sel && col.auth_status, col);
  const otherCols = before.cols.split(",");
  const [allOthers] = await q(`select bool_and(has_column_privilege('authenticated', 'public.pay_links', c, 'SELECT')) as ok
                                 from unnest($1::text[]) c`, [otherCols]);
  ok("authenticated keeps SELECT on every column that existed before", allOthers.ok, otherCols.length);

  // fixtures
  const makeUser = async (who, role) => {
    const [{ id }] = await q(`insert into auth.users (id, aud, role, email) values (gen_random_uuid(), 'authenticated', 'authenticated', $1) returning id`, [mail(who)]);
    await q(`delete from public.profiles where id = $1`, [id]);
    await q(`insert into public.profiles (id, role, full_name) values ($1, $2, $3)`, [id, role, `Pay-token probe ${who}`]);
    return { id, claims: { sub: id, role: "authenticated", email: mail(who) } };
  };
  const staff = await makeUser("staff", "staff");
  const owner = await makeUser("owner", "owner");
  const customer = await makeUser("customer", "customer");
  const asStaff = (fn) => asRole("authenticated", staff.claims, fn);
  const asCustomer = (fn) => asRole("authenticated", customer.claims, fn);
  const asAnon = (fn) => asRole("anon", { role: "anon" }, fn);
  await asRole("authenticated", owner.claims, () => q(`update public.cl_pay_link_settings set enabled = true`));

  const sizes = (await q(`select unnest(enum_range(null::dumpster_size))::text as s`)).map((r) => r.s);
  const pool = [];
  for (let d = 5; d < 90 && pool.length < 12; d += 3) {
    for (const s of sizes) {
      const [a] = await q(`select (public.yard_today() + $2::int)::text as day, total - committed as free, blocked
                             from public.size_availability($1::dumpster_size, public.yard_today() + $2::int, public.yard_today() + $2::int, 5)`, [s, d]);
      if (!a.blocked && a.free >= 1) pool.push([s, a.day]);
    }
  }
  ok("found free slots for the checks", pool.length >= 8, pool.length);
  const ph = (n) => Array.from({ length: n }, (_, i) => `$${i + 1}`).join(", ");
  const book = async (who, key) => {
    const [size, day] = pool.shift();
    const r = await asStaff(() => attempt(() => q(`select * from public.staff_create_pay_link_booking(${ph(13)})`,
      [size, day, "1 Probe St, Columbus, OH 43215", "Probe Person", 5, null, null, mail(who), null, null, false, null, key])));
    if (!r.ok) throw new Error(`booking failed: ${r.message}`);
    return r.value[0];
  };
  const stored = async (bookingId) =>
    (await q(`select status, token_encrypted from public.pay_links where booking_id = $1 order by created_at`, [bookingId]));
  const remind = async (bookingId, key) =>
    (await svc(() => q(`select public.pay_link_reminder_token($1, $2) as r`, [bookingId, key])))[0].r;

  console.log("-- reads of the column by role");
  const A = await book("a", KEY);
  const staffRead = await asStaff(() => attempt(() => q(`select token_encrypted from public.pay_links`)));
  ok("staff: select token_encrypted -> 42501", !staffRead.ok && staffRead.code === "42501", staffRead.code);
  const staffStar = await asStaff(() => attempt(() => q(`select * from public.pay_links`)));
  ok("staff: select * -> 42501 (the column is in *)", !staffStar.ok && staffStar.code === "42501", staffStar.code);
  const staffCols = await asStaff(() => attempt(() => q(`select id, booking_id, status, agreement_ack_at, paid_at from public.pay_links where booking_id = $1`, [A.booking_id])));
  ok("staff: the other columns, by name, still read (RLS staff read)", staffCols.ok && staffCols.value.length === 1, staffCols.ok ? staffCols.value.length : staffCols.message);
  const custRead = await asCustomer(() => attempt(() => q(`select token_encrypted from public.pay_links`)));
  ok("customer session: 42501", !custRead.ok && custRead.code === "42501", custRead.code);
  const anonRead = await asAnon(() => attempt(() => q(`select token_encrypted from public.pay_links`)));
  ok("anon: 42501", !anonRead.ok && anonRead.code === "42501", anonRead.code);
  const svcRead = await svc(() => attempt(() => q(`select token_encrypted from public.pay_links where booking_id = $1`, [A.booking_id])));
  ok("service_role reads it", svcRead.ok && svcRead.value.length === 1);

  console.log("-- what is stored");
  const [sa] = await stored(A.booking_id);
  ok("issued WITH a key: an encrypted copy is stored", sa.status === "active" && Buffer.isBuffer(sa.token_encrypted) && sa.token_encrypted.length > 40);
  ok("  ...the plaintext token is nowhere in the stored bytes", !sa.token_encrypted.toString("latin1").includes(A.token));
  const [{ cipher }] = await q(`select extensions.pgp_sym_decrypt(token_encrypted, $2) = $3 as cipher
                                 from public.pay_links where booking_id = $1 and status = 'active'`, [A.booking_id, KEY, A.token]);
  ok("  ...it decrypts with the key to exactly the issued token", cipher === true);
  const [{ algo }] = await q(`select extensions.pgp_sym_decrypt(token_encrypted, $2, 'cipher-algo=aes256') = $3 as algo
                               from public.pay_links where booking_id = $1 and status = 'active'`, [A.booking_id, KEY, A.token]);
  ok("  ...as an AES-256 pgp message", algo === true);
  const B = await book("b", null);
  ok("issued WITHOUT a key: nothing stored (link still issued)", (await stored(B.booking_id))[0].token_encrypted === null && /^[A-Za-z0-9_-]{43}$/.test(B.token));
  const E = await book("e", "");
  ok("an empty key counts as no key", (await stored(E.booking_id))[0].token_encrypted === null);

  console.log("-- pay_link_reminder_token (service_role)");
  const r1 = await remind(A.booking_id, KEY);
  ok("ok: returns exactly the live token", r1.state === "ok" && r1.token === A.token, r1.state);
  ok("wrong key -> decrypt_failed", (await remind(A.booking_id, `${KEY}x`)).state === "decrypt_failed");
  ok("no key -> no_key", (await remind(A.booking_id, null)).state === "no_key");
  ok("link without a stored copy -> no_stored_token", (await remind(B.booking_id, KEY)).state === "no_stored_token");
  ok("a booking with no active link -> no_link", (await remind("00000000-0000-0000-0000-000000000000", KEY)).state === "no_link");
  const staffRemind = await asStaff(() => attempt(() => q(`select public.pay_link_reminder_token($1, $2)`, [A.booking_id, KEY])));
  ok("staff cannot call it (42501)", !staffRemind.ok && staffRemind.code === "42501", staffRemind.code);

  console.log("-- resend");
  const oneArg = await asStaff(() => attempt(() => q(`select public.issue_pay_link($1) as t`, [B.booking_id])));
  ok("the one-argument call (current staff library) still works", oneArg.ok && /^[A-Za-z0-9_-]{43}$/.test(oneArg.value[0].t), oneArg.ok ? "ok" : oneArg.message);
  const re = await asStaff(() => attempt(() => q(`select public.issue_pay_link($1, $2) as t`, [B.booking_id, KEY])));
  const B2 = re.value[0].t;
  const bRows = await stored(B.booking_id);
  ok("resend with the key: the new link has a stored copy; every superseded one has none",
    bRows.filter((x) => x.status === "active").length === 1 && bRows.find((x) => x.status === "active").token_encrypted !== null &&
      bRows.filter((x) => x.status === "superseded").every((x) => x.token_encrypted === null), bRows.map((x) => [x.status, !!x.token_encrypted]));
  ok("  ...and the reminder now gets the NEW token", (await remind(B.booking_id, KEY)).token === B2);
  const reA = await asStaff(() => q(`select public.issue_pay_link($1, $2) as t`, [A.booking_id, KEY]));
  const aRows = await stored(A.booking_id);
  ok("resending A clears A's old stored copy", aRows.find((x) => x.status === "superseded").token_encrypted === null && (await remind(A.booking_id, KEY)).token === reA[0].t);

  console.log("-- the copy is cleared whenever the link stops being active");
  const [{ total: aTotal }] = await q(`select total from public.bookings where id = $1`, [A.booking_id]);
  const began = (await svc(() => q(`select public.pay_link_begin_charge($1, $2, true) as r`, [reA[0].t, aTotal])))[0].r;
  const rec = (await svc(() => q(`select public.record_pay_link_payment($1, $2, 'probe-ch-1', $3, false) as r`, [began.link_id, began.request_id, aTotal])))[0].r;
  ok("paid through the link -> cleared", rec === "recorded" && (await stored(A.booking_id)).every((x) => x.token_encrypted === null));
  const C = await book("c", KEY);
  await asStaff(() => q(`select public.record_manual_payment($1, 'cash', null, null)`, [C.booking_id]));
  ok("paid by cash -> link ended, cleared", (await stored(C.booking_id)).every((x) => x.status === "ended" && x.token_encrypted === null));
  const D = await book("d", KEY);
  await asStaff(() => q(`select public.set_booking_status($1, 'cancelled')`, [D.booking_id]));
  ok("cancelled -> link ended, cleared", (await stored(D.booking_id)).every((x) => x.status === "ended" && x.token_encrypted === null));
  const F = await book("f", KEY);
  await q(`update public.pay_links set status = 'ended', ended_at = now(), ended_reason = 'payment_status_changed' where booking_id = $1`, [F.booking_id]);
  ok("any direct status change -> cleared by the trigger", (await stored(F.booking_id))[0].token_encrypted === null);
  const forced = await attempt(() => q(`alter table public.pay_links disable trigger pay_links_clear_token;
      update public.pay_links set token_encrypted = '\\x01' where booking_id = '${F.booking_id}';`));
  ok("check constraint refuses a stored copy on a dead link even with the trigger off (23514)", !forced.ok && forced.code === "23514", forced.code);

  console.log("-- decrypt-and-send, then the log scan");
  const G = await book("g", KEY);
  const tok = (await remind(G.booking_id, KEY)).token;
  const sent = `Pay here: https://app.crazylarrysdumpsters.com/pay/${tok}`;
  const logged = sent.replace(/\/pay\/[A-Za-z0-9_-]{43}/g, "/pay/…"); // exactly what notify.ts writeLog stores
  const SCAN = `with cand as (
      select n.id, m[1] as token from public.notifications_log n,
        regexp_matches(coalesce(n.body, '') || ' ' || coalesce(n.error, ''), '/pay/([A-Za-z0-9_-]{43})', 'g') m)
    select cand.id from cand join public.pay_links l on l.token_hash = public._pay_link_hash(cand.token) where l.status = 'active'`;
  await q(`insert into public.notifications_log (booking_id, type, channel, recipient, delivery_status, body)
           values ($1, 'booking_confirmation', 'email', $2, 'sent', $3)`, [G.booking_id, mail("g"), logged]);
  ok("decrypted token is the live one, and the redacted log row holds no live token", tok === G.token && (await q(SCAN)).length === 0);
  await q(`insert into public.notifications_log (booking_id, type, channel, recipient, delivery_status, body)
           values ($1, 'booking_confirmation', 'email', $2, 'sent', $3)`, [G.booking_id, mail("g"), sent]);
  ok("an unredacted row IS caught by the scan (positive control)", (await q(SCAN)).length === 1);

  console.log("-- live counts for Settings");
  const counts = await asStaff(() => attempt(() => q(`select * from public.pay_link_live_counts()`)));
  const [truth] = await q(`select count(*)::int as live, count(*) filter (where token_encrypted is null)::int as without from public.pay_links where status = 'active'`);
  ok("staff: live and without-stored-link counts", counts.ok && counts.value[0].live === truth.live && counts.value[0].without_stored_link === truth.without, counts.ok ? counts.value[0] : counts.message);
  const custCounts = await asCustomer(() => attempt(() => q(`select * from public.pay_link_live_counts()`)));
  ok("customer: 42501", !custCounts.ok && custCounts.code === "42501", custCounts.code);
} finally {
  await c.query("rollback");
}

const after = await snapshot();
console.log("AFTER ROLLBACK", JSON.stringify({ counts: after.counts, pay_links_columns: after.cols }));
ok("every function md5 and ACL identical before and after (old signatures back, new ones gone)",
  Object.keys(before.fns).every((s) => JSON.stringify(after.fns[s]) === JSON.stringify(before.fns[s])));
ok("pay_links columns, table ACL and settings identical (feature still OFF)",
  after.cols === before.cols && after.acl === before.acl && after.settings === before.settings && JSON.parse(after.settings).enabled === false);
ok("row counts identical; no probe user left", JSON.stringify(after.counts) === JSON.stringify(before.counts) && after.counts.probe_users === 0);
await c.end();
console.log(failures ? `\n${failures} FAILED (rolled back)` : "\nALL PASS (rolled back)");
process.exit(failures ? 1 : 0);
