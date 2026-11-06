// Rolled-back probe for supabase/migrations/20261106000000_protected_visible_to_self.sql.
//
//   node --use-system-ca scripts/probe-protected-visibility.mjs     (repo root; reads DATABASE_URL from .env.local)
//
// Everything runs in ONE transaction that is always rolled back (finally): the
// migration itself, throwaway accounts, and every write attempted below. Real
// accounts are used only for reads, for writes the database must refuse, and
// for one name edit undone by a savepoint. Prints ids shortened, never emails
// or phone numbers.
//
// The last-owner check uses a fake count (_assert_owners_remain) and a throwaway
// owner. It never removes or demotes a real owner.
//
// Safe to re-run after the migration is applied: "before" is then already the
// new rule, and the probe says so.
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

const MIGRATION = "supabase/migrations/20261106000000_protected_visible_to_self.sql";
const PROTECTED = "554aa729-d7df-45e4-b48b-c7132c304af5";
const FIXTURE_LIKE = "protected-probe-%";
const TAG = crypto.randomUUID().slice(0, 8);
const mail = (who) => `protected-probe-${TAG}-${who}@example.com`;
const short = (id) => String(id).slice(0, 8);

const UNCHANGED_FUNCTIONS = [
  "public.guard_profile_admin_fields()",
  "public.enforce_profile_role_change()",
  "public._visible_owner_count()",
  "public._assert_owners_remain(integer)",
  "public.remove_staff_user(uuid)",
  "public.restore_staff_user(uuid)",
  "public.open_jobs_for_profile(uuid)",
  "public.account_reference_count(uuid)",
  "public.pay_link_staff_alert_recipients()",
  "public.validate_pay_link_settings()",
  "public.is_owner()",
  "public.is_staff()",
];

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
    return { ok: false, code: e.code, hint: e.hint };
  }
}
/** Runs fn as a role with these claims, then undoes everything fn did. */
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
  await q(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [
    JSON.stringify(claims),
    claims.sub ?? "",
  ]);
  try {
    return await fn();
  } finally {
    await c.query("reset role");
    await q(`select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)`);
  }
}
const authed = (id, fn) => asRole("authenticated", { sub: id, role: "authenticated" }, fn);
const refused = (r, hint) => !r.ok && r.code === "42501" && (hint === undefined || r.hint === hint);

const attrs = async () =>
  (
    await q(`select pg_get_function_identity_arguments(p.oid) as args,
                    pg_get_function_result(p.oid) as result,
                    p.prosecdef as definer, p.provolatile as volatility, p.proconfig::text as config,
                    pg_get_userbyid(p.proowner) as owner, l.lanname as lang, p.proacl::text as acl
               from pg_proc p join pg_language l on l.oid = p.prolang
              where p.oid = 'public.list_staff_users()'::regprocedure`)
  )[0];
const body = async () => (await q(`select prosrc from pg_proc where oid = 'public.list_staff_users()'::regprocedure`))[0].prosrc;
const md5s = async () => {
  const out = {};
  for (const sig of UNCHANGED_FUNCTIONS) {
    out[sig] = (await q(`select md5(pg_get_functiondef(oid)) || ' ' || coalesce(proacl::text, '') as m from pg_proc where oid = $1::regprocedure`, [sig]))[0].m;
  }
  return out;
};
const flagCounts = async () =>
  (
    await q(`select count(*)::int as profiles,
                    count(*) filter (where is_protected)::int as protected,
                    count(*) filter (where hidden_from_users)::int as hidden,
                    count(*) filter (where role = 'owner')::int as owners
               from public.profiles`)
  )[0];
const recipients = async () => (await q(`select profile_id::text as id, via_fallback from public.pay_link_staff_alert_recipients()`)).map((r) => `${r.id}:${r.via_fallback}`);
const list = async (id) => authed(id, () => q(`select * from public.list_staff_users()`));
const ids = (rows) => rows.map((r) => r.id);

async function snapshot() {
  await c.query("begin transaction read only");
  try {
    return {
      attrs: await attrs(),
      body: await body(),
      md5s: await md5s(),
      flags: await flagCounts(),
      authUsers: (await q(`select count(*)::int as n from auth.users`))[0].n,
      fixtures: (await q(`select count(*)::int as n from auth.users where email like $1`, [FIXTURE_LIKE]))[0].n,
      migrations: (await q(`select count(*)::int as n from supabase_migrations.schema_migrations`))[0].n,
    };
  } finally {
    await c.query("rollback");
  }
}

await c.connect();
const before = await snapshot();
try {
  await c.query("begin");
  await c.query("set local lock_timeout = '5s'");

  const [{ id: otherOwner }] = await q(
    `select id::text from public.profiles where role = 'owner' and removed_at is null and not hidden_from_users and not is_protected order by created_at limit 1`,
  );
  const [{ id: hiddenProtected }] = await q(`select id::text from public.profiles where role = 'owner' and is_protected and hidden_from_users limit 1`);
  const hiddenIds = (await q(`select id::text from public.profiles where hidden_from_users`)).map((r) => r.id);
  const ownerCountBefore = (await q(`select public._visible_owner_count() as n`))[0].n;
  const recipientsBefore = await recipients();
  const beforeOther = await list(otherOwner);
  const beforeSelf = await list(PROTECTED);
  const alreadyApplied = !ids(beforeOther).includes(PROTECTED);
  console.log(`-- other owner ${short(otherOwner)}; ${alreadyApplied ? "the rule is ALREADY live, so before = after" : "the rule is not live yet"}`);
  ok("before: the protected account sees its own row", ids(beforeSelf).includes(PROTECTED));

  console.log("-- apply the migration inside this transaction");
  await c.query(fs.readFileSync(MIGRATION, "utf8"));

  console.log("-- definition");
  const after = await attrs();
  for (const k of ["args", "result", "definer", "volatility", "config", "owner", "lang", "acl"]) {
    ok(`${k} unchanged`, after[k] === before.attrs[k], k === "result" ? undefined : after[k]);
  }
  ok("exactly one list_staff_users", (await q(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'list_staff_users'`))[0].n === 1);
  const LINE = "      and (not p.is_protected or p.id = auth.uid())\n";
  const afterBody = (await body()).replace(/\r\n/g, "\n");
  const beforeBody = before.body.replace(/\r\n/g, "\n");
  ok(
    alreadyApplied ? "body unchanged by re-applying" : "the body changed by exactly the one new line",
    alreadyApplied ? afterBody === beforeBody : afterBody.includes(LINE) && afterBody.replace(LINE, "") === beforeBody,
  );
  const exec = (await q(`select has_function_privilege('anon', 'public.list_staff_users()', 'EXECUTE') as anon,
      has_function_privilege('authenticated', 'public.list_staff_users()', 'EXECUTE') as auth,
      has_function_privilege('service_role', 'public.list_staff_users()', 'EXECUTE') as svc`))[0];
  ok("execute: authenticated and service_role yes, anon no", exec.auth && exec.svc && !exec.anon, exec);

  console.log("-- as the protected account");
  const self = await list(PROTECTED);
  const own = self.find((r) => r.id === PROTECTED);
  ok("sees its own row, marked protected", own?.is_protected === true);
  ok("own row has the full columns", Object.keys(own ?? {}).length === 16 && !!own?.email);
  ok("sees exactly what it saw before", JSON.stringify(self) === JSON.stringify(beforeSelf), self.length);

  console.log("-- as another owner");
  const other = await list(otherOwner);
  ok("no row for the protected account", !ids(other).includes(PROTECTED), other.length);
  ok("no protected row of any kind", other.every((r) => !r.is_protected));
  ok(
    "every other row is identical to before",
    JSON.stringify(other) === JSON.stringify(beforeOther.filter((r) => r.id !== PROTECTED)),
  );
  ok("sees everyone the protected account sees, except that row", JSON.stringify(other) === JSON.stringify(self.filter((r) => r.id !== PROTECTED)));
  ok("hidden accounts stay hidden", other.every((r) => !hiddenIds.includes(r.id)));

  console.log("-- a hidden, protected owner");
  const hiddenView = await list(hiddenProtected);
  ok("still doesn't see itself: hidden wins, as before", !ids(hiddenView).includes(hiddenProtected));
  ok("doesn't see the other protected account", !ids(hiddenView).includes(PROTECTED));

  // Checked before the throwaway owner exists, since that owner would join the fallback.
  ok("alert fallback: the same recipients, protected account included", JSON.stringify(await recipients()) === JSON.stringify(recipientsBefore) && recipientsBefore.some((r) => r.startsWith(PROTECTED)), recipientsBefore.length);

  console.log("-- who may call it (throwaway accounts)");
  async function makeUser(who, role) {
    const [{ id }] = await q(`insert into auth.users (id, aud, role, email) values (gen_random_uuid(), 'authenticated', 'authenticated', $1) returning id::text`, [mail(who)]);
    await q(`delete from public.profiles where id = $1`, [id]);
    await q(`insert into public.profiles (id, role, full_name) values ($1, $2, $3)`, [id, role, `Protected probe ${who}`]);
    return id;
  }
  const staff = await makeUser("staff", "staff");
  const customer = await makeUser("customer", "customer");
  const call = () => attempt(() => q(`select * from public.list_staff_users()`));
  ok("staff refused", refused(await authed(staff, call)));
  ok("customer refused", refused(await authed(customer, call)));
  ok("anon refused", refused(await asRole("anon", { role: "anon" }, call)));
  ok("service_role refused, as before: is_owner() is false", refused(await asRole("service_role", { role: "service_role" }, call)));

  console.log("-- protection unchanged: another owner");
  const write = (sql, params) => () => attempt(() => q(sql, params));
  ok("role change refused", refused(await authed(otherOwner, write(`update public.profiles set role = 'staff' where id = $1`, [PROTECTED])), "protected"));
  ok("edit refused", refused(await authed(otherOwner, write(`update public.profiles set full_name = 'x' where id = $1`, [PROTECTED])), "protected"));
  ok("remove refused", refused(await authed(otherOwner, write(`select public.remove_staff_user($1)`, [PROTECTED])), "protected"));
  ok("delete refused", refused(await authed(otherOwner, write(`delete from public.profiles where id = $1`, [PROTECTED])), "profile_delete"));

  console.log("-- protection unchanged: the account itself");
  ok("own role change refused", refused(await authed(PROTECTED, write(`update public.profiles set role = 'staff' where id = $1`, [PROTECTED])), "protected"));
  ok("own removal refused", refused(await authed(PROTECTED, write(`select public.remove_staff_user($1)`, [PROTECTED])), "protected"));
  ok("own delete refused", refused(await authed(PROTECTED, write(`delete from public.profiles where id = $1`, [PROTECTED])), "profile_delete"));
  ok("own flag change refused", refused(await authed(PROTECTED, write(`update public.profiles set is_protected = false where id = $1`, [PROTECTED])), "admin_fields"));
  const edited = await undone(() => authed(PROTECTED, write(`update public.profiles set full_name = 'Probe edit' where id = $1 returning id`, [PROTECTED])));
  ok("own name edit still works (undone)", edited.ok && edited.value.length === 1);

  console.log("-- last owner unchanged: fake count and a throwaway owner");
  ok("count unchanged by the migration", (await q(`select public._visible_owner_count() as n`))[0].n === ownerCountBefore, ownerCountBefore);
  ok("the protected, shown owner is still counted", (await q(`select count(*)::int as n from public.profiles where id = $1 and role = 'owner' and removed_at is null and not hidden_from_users`, [PROTECTED]))[0].n === 1);
  const fake = (n) => () => attempt(() => q(`select public._assert_owners_remain($1::int)`, [n]));
  ok("fake count 0 refused", refused(await authed(otherOwner, fake(0)), "last_owner"));
  ok("fake count null refused", refused(await authed(otherOwner, fake(null)), "last_owner"));
  ok("fake count 1 passes", (await authed(otherOwner, fake(1))).ok);
  const tempOwner = await makeUser("owner", "owner");
  ok("throwaway owner counts", (await q(`select public._visible_owner_count() as n`))[0].n === ownerCountBefore + 1);
  const removed = await undone(() => authed(tempOwner, write(`select public.remove_staff_user($1)`, [tempOwner])));
  ok("throwaway owner can still be removed through the guard (undone)", removed.ok);

  console.log("-- alerts unchanged");
  const chooseSelf = await undone(async () => {
    const chosen = await authed(PROTECTED, write(`update public.cl_pay_link_settings set staff_alert_user_id = $1 where id returning id`, [PROTECTED]));
    const kept = await authed(otherOwner, write(`update public.cl_pay_link_settings set staff_alert_user_id = $1 where id returning id`, [PROTECTED]));
    const shown = await asRole("service_role", { role: "service_role" }, () => q(`select profile_id::text as id, via_fallback from public.pay_link_staff_alert_recipients()`));
    return { chosen, kept, shown };
  });
  ok("it can still choose itself as the alert person (undone)", chooseSelf.chosen.ok && chooseSelf.chosen.value.length === 1);
  ok("another owner can save that same value: Current recipient (undone)", chooseSelf.kept.ok && chooseSelf.kept.value.length === 1);
  ok("once chosen, it alone gets the alert (undone)", chooseSelf.shown.length === 1 && chooseSelf.shown[0].id === PROTECTED && chooseSelf.shown[0].via_fallback === false);

  console.log("-- nothing else moved");
  const m = await md5s();
  for (const sig of UNCHANGED_FUNCTIONS) ok(`${sig.replace("public.", "")} unchanged`, m[sig] === before.md5s[sig]);
} finally {
  await c.query("rollback").catch(() => {});
}

console.log("-- after ROLLBACK");
const end = await snapshot();
ok("list_staff_users body back to the start", end.body === before.body);
ok("list_staff_users attributes back to the start", JSON.stringify(end.attrs) === JSON.stringify(before.attrs));
ok("every other function back to the start", JSON.stringify(end.md5s) === JSON.stringify(before.md5s));
ok("profile counts and flags identical", JSON.stringify(end.flags) === JSON.stringify(before.flags), end.flags);
ok("auth.users count identical", end.authUsers === before.authUsers);
ok("no fixture accounts left", end.fixtures === 0);
ok("migration history untouched", end.migrations === before.migrations, end.migrations);
await c.end();

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED, EVERYTHING ROLLED BACK");
process.exit(failures ? 1 : 0);
