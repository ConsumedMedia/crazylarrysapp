// Read-only check of the APPLIED 20261103000000_pay_links migration.
//
//   node scripts/check-pay-links-applied.mjs   (repo root; reads DATABASE_URL from .env.local)
//
// One READ ONLY transaction, rolled back: catalog reads and row counts only.
// Nothing is written, no role is assumed, no function is called that writes.
import fs from "node:fs";
import pg from "pg";

const url = fs.readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, "");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const q = async (sql, params) => (await c.query(sql, params)).rows;
let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
  if (!cond) failures++;
};

const TABLES = {
  cl_pay_link_settings: { select: true, insert: false, update: true, delete: false, policies: ["cl_pay_link_settings: owner update", "cl_pay_link_settings: staff read"] },
  pay_links: { select: true, insert: false, update: false, delete: false, policies: ["pay_links: staff read"] },
  pay_link_events: { select: true, insert: false, update: false, delete: false, policies: ["pay_link_events: staff read"] },
  consent_records: { select: true, insert: false, update: false, delete: false, policies: ["consent_records: staff read"] },
  pay_link_lookup_attempts: { select: false, insert: false, update: false, delete: false, policies: [] },
};
const FUNCTIONS = {
  "issue_pay_link(uuid)": "staff",
  "staff_create_pay_link_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,boolean,uuid)": "staff",
  "resolve_payment_attempt(uuid)": "staff",
  "pay_link_lookup(text,text)": "service",
  "pay_link_begin_charge(text,numeric,boolean)": "service",
  "pay_link_clear_charge(uuid,uuid)": "service",
  "record_pay_link_payment(uuid,uuid,text,numeric,boolean)": "service",
  "pay_link_due_events(date)": "service",
  "claim_pay_link_event(uuid,text,integer,date)": "service",
  "finish_pay_link_event(uuid,text,integer,text,text)": "service",
  "pay_link_staff_alert_recipients()": "service",
  "purge_pay_link_lookup_attempts()": "service",
  "_pay_link_hash(text)": "internal",
  "_issue_pay_link(uuid,uuid)": "internal",
  "_assert_pay_link_issuable(uuid)": "internal",
  "end_pay_links_on_booking_change()": "internal",
  "validate_pay_link_settings()": "internal",
};

await c.connect();
await c.query("begin transaction read only");
try {
  console.log("-- migration history");
  const [m] = await q(`select count(*)::int as n, max(version) as latest,
      bool_or(version = '20261103000000') as applied from supabase_migrations.schema_migrations`);
  ok("20261103000000 is recorded as applied", m.applied, m);

  console.log("-- tables, RLS, policies, grants");
  for (const [t, want] of Object.entries(TABLES)) {
    const [r] = await q(`select c.relrowsecurity as rls,
        has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_any,
        has_table_privilege('authenticated', c.oid, 'SELECT') as select,
        has_table_privilege('authenticated', c.oid, 'INSERT') as insert,
        has_table_privilege('authenticated', c.oid, 'UPDATE') as update,
        has_table_privilege('authenticated', c.oid, 'DELETE') as delete,
        has_table_privilege('authenticated', c.oid, 'TRUNCATE,REFERENCES,TRIGGER') as auth_extra,
        has_table_privilege('service_role', c.oid, 'SELECT') as svc_select,
        (select coalesce(array_agg(polname::text order by polname), '{}') from pg_policy where polrelid = c.oid) as policies
      from pg_class c where c.oid = to_regclass('public.' || $1)`, [t]);
    const grants = { select: r?.select, insert: r?.insert, update: r?.update, delete: r?.delete };
    ok(`${t}: RLS on, anon nothing, authenticated ${JSON.stringify(grants)}, policies ${JSON.stringify(r?.policies)}`,
      !!r && r.rls && !r.anon_any && !r.auth_extra && r.svc_select &&
        ["select", "insert", "update", "delete"].every((k) => r[k] === want[k]) &&
        JSON.stringify(r.policies) === JSON.stringify(want.policies));
  }
  const cols = await q(`select table_name, column_name, is_nullable, column_default from information_schema.columns
     where table_schema = 'public' and ((table_name = 'invoices' and column_name = 'pay_link_id')
        or (table_name = 'payment_attempts' and column_name in ('resolved_at', 'resolved_by'))) order by 1, 2`);
  ok("new nullable columns: invoices.pay_link_id, payment_attempts.resolved_at/resolved_by (no defaults)",
    cols.length === 3 && cols.every((x) => x.is_nullable === "YES" && x.column_default === null), cols.map((x) => `${x.table_name}.${x.column_name}`));
  const [idx] = await q(`select count(*)::int as n from pg_indexes where schemaname = 'public'
     and indexname = 'pay_links_one_active_per_booking' and indexdef like '%UNIQUE%' and indexdef like '%WHERE (status = ''active''::text)%'`);
  ok("partial unique index: one active link per booking", idx.n === 1);

  console.log("-- function EXECUTE matrix");
  for (const [sig, kind] of Object.entries(FUNCTIONS)) {
    const [r] = await q(`select p.prosecdef as definer, p.proconfig::text as config,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
        has_function_privilege('public', p.oid, 'EXECUTE') as public
      from pg_proc p where p.oid = to_regprocedure('public.' || $1)`, [sig]);
    const good = !!r && !r.anon && !r.public && r.config === "{search_path=public}" &&
      (kind === "staff" ? r.authenticated : !r.authenticated) && (kind === "internal" || r.service_role);
    ok(`${kind.padEnd(8)} ${sig.split("(")[0]}: anon=${r?.anon} public=${r?.public} authenticated=${r?.authenticated} service_role=${r?.service_role} definer=${r?.definer}`, good);
  }

  console.log("-- trigger on bookings");
  const [tg] = await q(`select t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) as def, p.proname
      from pg_trigger t join pg_proc p on p.oid = t.tgfoid
     where t.tgrelid = 'public.bookings'::regclass and t.tgname = 'bookings_end_pay_links'`);
  ok("bookings_end_pay_links exists, enabled, AFTER UPDATE OF payment_status, status, row-level, guarded by WHEN",
    !!tg && tg.tgenabled === "O" && /AFTER UPDATE OF payment_status, status ON public\.bookings FOR EACH ROW WHEN/.test(tg.def) &&
      tg.proname === "end_pay_links_on_booking_change", tg?.def);
  const all = await q(`select tgname from pg_trigger where tgrelid = 'public.bookings'::regclass and not tgisinternal order by 1`);
  ok("bookings triggers are exactly the old one plus the new one", JSON.stringify(all.map((x) => x.tgname)) === '["bookings_end_pay_links","bookings_set_updated_at"]', all.map((x) => x.tgname));
  const [st] = await q(`select count(*)::int as n from pg_trigger where tgrelid = 'public.cl_pay_link_settings'::regclass and not tgisinternal`);
  ok("settings has its two triggers (updated_at, recipient validation)", st.n === 2, st.n);

  console.log("-- notification types");
  const [en] = await q(`select string_agg(enumlabel::text, ',' order by enumsortorder) as v from pg_enum where enumtypid = 'public.notification_type'::regtype`);
  ok("notification_type ends with pay_link, pay_link_reminder, staff_unpaid_alert", en.v.endsWith(",job_assigned,pay_link,pay_link_reminder,staff_unpaid_alert"), en.v);

  console.log("-- settings (the feature must be OFF)");
  const s = await q(`select enabled, reminder_after_days, reminder_repeat, reminder_max, staff_alert_after_days,
      staff_alert_user_id, staff_alert_each_reminder from public.cl_pay_link_settings`);
  ok("exactly one settings row: OFF, N=2, repeat off, max 3, M=3, no recipient, no per-reminder alert",
    s.length === 1 && s[0].enabled === false && s[0].reminder_after_days === 2 && s[0].reminder_repeat === false &&
      s[0].reminder_max === 3 && s[0].staff_alert_after_days === 3 && s[0].staff_alert_user_id === null &&
      s[0].staff_alert_each_reminder === false, s[0]);

  console.log("-- nothing has used it yet");
  const [n] = await q(`select (select count(*)::int from public.pay_links) as pay_links,
      (select count(*)::int from public.pay_link_events) as events,
      (select count(*)::int from public.consent_records) as consent_records,
      (select count(*)::int from public.pay_link_lookup_attempts) as lookup_attempts,
      (select count(*)::int from public.invoices where pay_link_id is not null) as invoices_with_link,
      (select count(*)::int from public.payment_attempts where resolved_at is not null) as resolved_attempts`);
  ok("all new tables empty, no invoice linked, no attempt resolved", Object.values(n).every((v) => v === 0), n);

  console.log("-- token scan over notifications_log");
  const live = await q(`with cand as (
      select n.id, m[1] as token from public.notifications_log n,
        regexp_matches(coalesce(n.body, '') || ' ' || coalesce(n.error, ''), '/pay/([A-Za-z0-9_-]{43})', 'g') m)
    select cand.id from cand join public.pay_links l on l.token_hash = public._pay_link_hash(cand.token) where l.status = 'active'`);
  ok("no live pay-link token in notifications_log", live.length === 0, live.length);
} finally {
  await c.query("rollback");
  await c.end();
}
console.log(failures ? `\n${failures} FAILED (read only)` : "\nALL PASS (read only)");
process.exit(failures ? 1 : 0);
