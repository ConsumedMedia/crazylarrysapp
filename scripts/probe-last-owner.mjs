// Rolled-back probe for supabase/migrations/20261109000000_last_counted_owner.sql.
//
//   node --use-system-ca scripts/probe-last-owner.mjs     (repo root; reads DATABASE_URL from .env.local)
//
// Everything runs in ONE transaction that is always rolled back (finally): the
// migration itself, throwaway accounts, the fake counts and every write
// attempted below. Real owners are only READ. The only writes aimed at a real
// account are ones the database must refuse (the protected account). Prints
// ids shortened, never emails or phone numbers.
//
// The "last owner" cases use a FAKE count: inside a savepoint,
// _counted_owners_other_than is replaced with one returning 0, 1 or null, and
// throwaway owners are demoted or removed. The real function is back the moment
// the savepoint is rolled back.
//
// Not covered: two owners removing each other at the same moment. One
// transaction can't race itself, so the advisory lock is checked by reading the
// definition only.
//
// Safe to re-run after the migration is applied: "before" is then already the
// new rule, and the probe says so.
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

const MIGRATION = "supabase/migrations/20261109000000_last_counted_owner.sql";
const PROTECTED = "554aa729-d7df-45e4-b48b-c7132c304af5";
const EXPECTED_COUNTED = ["923ed11f", "06c35695", "56ec379d"];
const FIXTURE_LIKE = "last-owner-probe-%";
const TAG = crypto.randomUUID().slice(0, 8);
const mail = (who) => `last-owner-probe-${TAG}-${who}@example.com`;
const short = (id) => String(id).slice(0, 8);
const ADVICE = "Add another owner first";

const UNCHANGED_FUNCTIONS = [
  "public.enforce_profile_role_change()",
  "public._visible_owner_count()",
  "public.remove_staff_user(uuid)",
  "public.restore_staff_user(uuid)",
  "public.list_staff_users()",
  "public.pay_link_staff_alert_recipients()",
  "public.is_owner()",
  "public.is_staff()",
];
const NEW_FUNCTIONS = ["public._owner_login_active(uuid)", "public._counted_owners_other_than(uuid)"];

const OLD_BLOCK = `  -- Last-owner guard: a counted owner losing owner status or being removed.
  if old.role = 'owner' and old.removed_at is null and not old.hidden_from_users
     and (new.role is distinct from 'owner' or new.removed_at is not null) then
    -- Serialize concurrent demotions so two owners can't remove each other.
    perform pg_advisory_xact_lock(hashtext('cl_last_owner_guard'));
    perform public._assert_owners_remain(public._visible_owner_count() - 1);
  end if;`;
const NEW_BLOCK = `  -- Last-owner guard: a COUNTED owner (see _counted_owners_other_than) losing
  -- owner status or being removed must leave at least one other counted owner.
  if old.role = 'owner' and old.removed_at is null and not old.hidden_from_users
     and not old.is_protected
     and (new.role is distinct from 'owner' or new.removed_at is not null)
     and public._owner_login_active(old.id) then
    -- Serialize concurrent demotions so two owners can't remove each other.
    perform pg_advisory_xact_lock(hashtext('cl_last_owner_guard'));
    perform public._assert_owners_remain(public._counted_owners_other_than(old.id));
  end if;`;

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
/** Runs fn, then undoes everything it did (fake functions included). */
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
const lastOwner = (r) => refused(r, "last_owner") && r.message.includes(ADVICE);
const passed = (r) => r.ok && Array.isArray(r.value) && r.value.length === 1;

const fnDef = async (sig) =>
  (await q(`select pg_get_functiondef(oid) as d, md5(pg_get_functiondef(oid)) || ' ' || coalesce(proacl::text, '') as m from pg_proc where oid = to_regprocedure($1)`, [sig]))[0];
const exists = async (sig) => (await q(`select to_regprocedure($1) is not null as e`, [sig]))[0].e;
const guardBody = async () => (await q(`select prosrc from pg_proc where oid = 'public.guard_profile_admin_fields()'::regprocedure`))[0].prosrc.replace(/\r\n/g, "\n");
const assertBody = async () => (await q(`select prosrc from pg_proc where oid = 'public._assert_owners_remain(integer)'::regprocedure`))[0].prosrc.replace(/\r\n/g, "\n");
const fnAttrs = async (sig) =>
  (
    await q(`select pg_get_function_result(p.oid) as result, p.prosecdef as definer, p.provolatile as volatility,
                    p.proconfig::text as config, pg_get_userbyid(p.proowner) as owner, l.lanname as lang, p.proacl::text as acl
               from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = $1::regprocedure`, [sig])
  )[0];
const triggers = async () =>
  (await q(`select tgname, pg_get_triggerdef(oid) as d, tgenabled from pg_trigger where tgrelid = 'public.profiles'::regclass and not tgisinternal order by tgname`)).map(
    (r) => `${r.tgname}|${r.tgenabled}|${r.d}`,
  );
const flagCounts = async () =>
  (
    await q(`select count(*)::int as profiles,
                    count(*) filter (where is_protected)::int as protected,
                    count(*) filter (where hidden_from_users)::int as hidden,
                    count(*) filter (where removed_at is not null)::int as removed,
                    count(*) filter (where role = 'owner')::int as owners,
                    md5(string_agg(id::text || role::text || coalesce(removed_at::text, ''), ',' order by id)) as owners_md5
               from public.profiles`)
  )[0];
// The rule written out in plain SQL, independent of the migration's functions.
const countedByHand = async () =>
  (
    await q(`select p.id::text from public.profiles p join auth.users u on u.id = p.id
              where p.role = 'owner' and p.removed_at is null and not p.hidden_from_users and not p.is_protected
                and u.email_confirmed_at is not null and (u.banned_until is null or u.banned_until <= now())
                and u.deleted_at is null order by p.id`)
  ).map((r) => r.id);

async function snapshot() {
  await c.query("begin transaction read only");
  try {
    const defs = {};
    for (const sig of [...UNCHANGED_FUNCTIONS, "public.guard_profile_admin_fields()", "public._assert_owners_remain(integer)", ...NEW_FUNCTIONS]) {
      defs[sig] = (await fnDef(sig))?.m ?? null;
    }
    return {
      defs,
      triggers: await triggers(),
      flags: await flagCounts(),
      counted: await countedByHand(),
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

  const alreadyApplied = before.defs[NEW_FUNCTIONS[1]] !== null;
  console.log(`-- ${alreadyApplied ? "the rule is ALREADY live, so before = after" : "the rule is not live yet"}`);
  const realCounted = before.counted;
  ok(
    "today's counted owners (plain SQL) are the three expected",
    JSON.stringify(realCounted.map(short).sort()) === JSON.stringify([...EXPECTED_COUNTED].sort()),
    realCounted.map(short),
  );
  ok("the protected account is not one of them", !realCounted.includes(PROTECTED));
  const guardBefore = await guardBody();
  const assertBefore = await assertBody();

  console.log("-- apply the migration inside this transaction");
  await c.query(fs.readFileSync(MIGRATION, "utf8"));

  console.log("-- definitions");
  const guardAfter = await guardBody();
  ok(
    alreadyApplied ? "guard body unchanged by re-applying" : "guard body changed in the last-owner block only",
    alreadyApplied ? guardAfter === guardBefore : guardBefore.includes(OLD_BLOCK) && guardAfter === guardBefore.replace(OLD_BLOCK, NEW_BLOCK),
  );
  const lockAt = guardAfter.indexOf("pg_advisory_xact_lock(hashtext('cl_last_owner_guard'))");
  const countAt = guardAfter.indexOf("_counted_owners_other_than(old.id)");
  ok("guard takes the advisory lock before counting", lockAt > 0 && countAt > lockAt);
  ok("guard no longer uses _visible_owner_count", !guardAfter.includes("_visible_owner_count"));
  const assertAfter = await assertBody();
  ok(
    alreadyApplied ? "_assert_owners_remain unchanged by re-applying" : "_assert_owners_remain: only the message text changed",
    alreadyApplied
      ? assertAfter === assertBefore
      : assertAfter.replace(/raise exception '[^']*'/, "X") === assertBefore.replace(/raise exception '[^']*'/, "X") && assertAfter !== assertBefore,
  );
  ok("triggers on profiles unchanged and enabled", JSON.stringify(await triggers()) === JSON.stringify(before.triggers), before.triggers.length);
  for (const sig of NEW_FUNCTIONS) {
    const a = await fnAttrs(sig);
    ok(`${sig.replace("public.", "")}: security definer, stable, search_path=public, owned by postgres`, a.definer && a.volatility === "s" && a.config === "{search_path=public}" && a.owner === "postgres", a);
    const priv = (await q(`select has_function_privilege('anon', $1, 'EXECUTE') as anon,
        has_function_privilege('authenticated', $1, 'EXECUTE') as auth,
        has_function_privilege('service_role', $1, 'EXECUTE') as svc`, [sig]))[0];
    ok(`${sig.replace("public.", "")}: execute authenticated and service_role yes, anon no`, priv.auth && priv.svc && !priv.anon, priv);
  }
  for (const sig of ["public.guard_profile_admin_fields()", "public._assert_owners_remain(integer)"]) {
    const a = await fnAttrs(sig);
    const b = (await fnDef(sig)).m.split(" ")[1] ?? "";
    ok(`${sig.replace("public.", "")}: grants unchanged`, (a.acl ?? "") === (before.defs[sig].split(" ")[1] ?? ""), b);
  }

  console.log("-- the real count, read only");
  const realOwner = realCounted[0];
  const viaFn = await authed(realOwner, () => q(`select public._counted_owners_other_than(null) as n`));
  ok("as an owner (role authenticated): all counted owners = 3", viaFn[0].n === 3, viaFn[0].n);
  for (const id of realCounted) {
    const [{ n }] = await authed(realOwner, () => q(`select public._counted_owners_other_than($1) as n`, [id]));
    ok(`others than ${short(id)} = 2`, n === 2, n);
  }
  const [{ n: othersThanProtected }] = await q(`select public._counted_owners_other_than($1) as n`, [PROTECTED]);
  ok("others than the protected account = 3 (it never counted)", othersThanProtected === 3);
  ok("_visible_owner_count unchanged (4, protected account included)", (await q(`select public._visible_owner_count() as n`))[0].n === 4);

  console.log("-- the refusal message");
  const msg = await authed(realOwner, () => attempt(() => q(`select public._assert_owners_remain(0)`)));
  ok("says to add another owner first, hint last_owner", lastOwner(msg), msg.message);

  console.log("-- throwaway owners");
  async function makeOwner(who, { confirmed = true, banned = false, deleted = false, hidden = false, isProtected = false, removed = false } = {}) {
    const [{ id }] = await q(
      `insert into auth.users (id, aud, role, email, email_confirmed_at, banned_until, deleted_at)
       values (gen_random_uuid(), 'authenticated', 'authenticated', $1,
               case when $2 then now() end, case when $3 then now() + interval '1 day' end, case when $4 then now() end)
       returning id::text`,
      [mail(who), confirmed, banned, deleted],
    );
    await q(`delete from public.profiles where id = $1`, [id]);
    await q(
      `insert into public.profiles (id, role, full_name, hidden_from_users, is_protected, removed_at)
       values ($1, 'owner', $2, $3, $4, case when $5 then now() end)`,
      [id, `Last owner probe ${who}`, hidden, isProtected, removed],
    );
    return id;
  }
  const A = await makeOwner("a");
  const B = await makeOwner("b");
  const unconfirmed = await makeOwner("unconfirmed", { confirmed: false });
  const banned = await makeOwner("banned", { banned: true });
  const deleted = await makeOwner("deleted", { deleted: true });
  const hidden = await makeOwner("hidden", { hidden: true });
  const prot = await makeOwner("protected", { isProtected: true });
  const removedOwner = await makeOwner("removed", { removed: true });
  const [{ n: withFixtures }] = await q(`select public._counted_owners_other_than(null) as n`);
  ok("only the two confirmed, active throwaway owners join the count (3 + 2)", withFixtures === 5, withFixtures);
  for (const [label, id] of [["unconfirmed (invite not accepted)", unconfirmed], ["banned", banned], ["deleted login", deleted], ["hidden", hidden], ["protected", prot], ["removed", removedOwner]]) {
    const [{ n }] = await q(`select public._counted_owners_other_than($1) as n`, [id]);
    ok(`${label} owner doesn't count`, n === 5, n);
  }

  const removeSql = (target) => () => attempt(() => q(`select public.remove_staff_user($1) as r`, [target]));
  const demoteSql = (target) => () => attempt(() => q(`update public.profiles set role = 'staff' where id = $1 returning id`, [target]));
  const renameSql = (target) => () => attempt(() => q(`update public.profiles set full_name = 'Renamed' where id = $1 returning id`, [target]));
  const run = (who, step) => undone(() => authed(who, step));

  console.log("-- real count: another counted owner remains");
  ok("A removes itself (self-removal still works)", passed(await run(A, removeSql(A))));
  ok("A demotes itself to staff", passed(await run(A, demoteSql(A))));
  ok("A removes B", passed(await run(A, removeSql(B))));
  ok("A demotes B", passed(await run(A, demoteSql(B))));
  const both = await undone(async () => {
    const first = await authed(A, removeSql(B));
    const second = await authed(A, removeSql(A));
    return { first, second };
  });
  ok("A removes B and then itself: the 3 real owners still count", passed(both.first) && passed(both.second));

  /** Swap in a fake count for the length of fn, then roll it back. */
  const withFake = (n, fn) =>
    undone(async () => {
      await q(`create or replace function public._counted_owners_other_than(p_id uuid) returns integer
               language sql stable security definer set search_path = public as $$ select ${n === null ? "null::int" : `${n}`} $$`);
      return fn();
    });

  // Each case gets its own fake and its own rollback, so no case sees another's write.
  const fakeAs = (n, who, step) => withFake(n, () => authed(who, step));
  const markRemovedSql = (target) => () => attempt(() => q(`update public.profiles set removed_at = now() where id = $1 returning id`, [target]));

  console.log("-- fake count 0: A is the last counted owner");
  const zero = {
    selfRemove: await fakeAs(0, A, removeSql(A)),
    selfDemote: await fakeAs(0, A, demoteSql(A)),
    removedByB: await fakeAs(0, B, removeSql(A)),
    demotedByB: await fakeAs(0, B, demoteSql(A)),
    selfRename: await fakeAs(0, A, renameSql(A)),
    unconfirmed: await fakeAs(0, A, removeSql(unconfirmed)),
    banned: await fakeAs(0, A, demoteSql(banned)),
    deleted: await fakeAs(0, A, removeSql(deleted)),
    hidden: await fakeAs(0, A, removeSql(hidden)),
    protectedOne: await fakeAs(0, A, removeSql(prot)),
    realProtected: await fakeAs(0, A, removeSql(PROTECTED)),
    serviceRoleDemote: await withFake(0, () => asRole("service_role", { role: "service_role" }, demoteSql(A))),
    rawPgDemote: await withFake(0, demoteSql(A)),
    serviceRoleMark: await withFake(0, () => asRole("service_role", { role: "service_role" }, markRemovedSql(A))),
    rawPgMark: await withFake(0, markRemovedSql(A)),
  };
  ok("A can't remove itself; message says to add another owner first", lastOwner(zero.selfRemove), zero.selfRemove.message);
  ok("A can't demote itself", lastOwner(zero.selfDemote));
  ok("B can't remove A", lastOwner(zero.removedByB));
  ok("B can't demote A", lastOwner(zero.demotedByB));
  ok("A can still rename itself", passed(zero.selfRename));
  ok("an unconfirmed owner can still be removed (doesn't count)", passed(zero.unconfirmed));
  ok("a banned owner can still be demoted (doesn't count)", passed(zero.banned));
  ok("an owner with a deleted login can still be removed (doesn't count)", passed(zero.deleted));
  ok("a hidden owner can still be removed (doesn't count)", passed(zero.hidden));
  ok("a throwaway protected owner: still refused as protected, not last_owner", refused(zero.protectedOne, "protected"));
  ok("the real protected account: still refused as protected", refused(zero.realProtected, "protected"));
  // Unchanged: the guard lets these through, as before, but the separate
  // role-change trigger still needs an owner session to demote an owner.
  ok("service role: guard lets it through (marking removed passes)", passed(zero.serviceRoleMark));
  ok("raw pg: guard lets it through (marking removed passes)", passed(zero.rawPgMark));
  ok("service role demoting an owner: still refused by the role-change trigger, not last_owner", refused(zero.serviceRoleDemote) && zero.serviceRoleDemote.hint !== "last_owner", zero.serviceRoleDemote.message);
  ok("raw pg demoting an owner: still refused by the role-change trigger, not last_owner", refused(zero.rawPgDemote) && zero.rawPgDemote.hint !== "last_owner", zero.rawPgDemote.message);

  console.log("-- fake count null: refused, never treated as fine");
  const nul = await fakeAs(null, A, removeSql(A));
  ok("A can't remove itself", lastOwner(nul));

  console.log("-- fake count 1: one other counted owner remains");
  const one = {
    selfRemove: await fakeAs(1, A, removeSql(A)),
    selfDemote: await fakeAs(1, A, demoteSql(A)),
    removedByB: await fakeAs(1, B, removeSql(A)),
  };
  ok("A removes itself", passed(one.selfRemove));
  ok("A demotes itself", passed(one.selfDemote));
  ok("B removes A", passed(one.removedByB));

  console.log("-- the real function is back after each fake");
  ok("count = 5 again", (await q(`select public._counted_owners_other_than(null) as n`))[0].n === 5);
  ok("A is still an active owner", (await q(`select count(*)::int as n from public.profiles where id = $1 and role = 'owner' and removed_at is null`, [A]))[0].n === 1);

  console.log("-- nothing else moved");
  for (const sig of UNCHANGED_FUNCTIONS) ok(`${sig.replace("public.", "")} unchanged`, (await fnDef(sig)).m === before.defs[sig]);
  ok("real owners untouched", JSON.stringify(await countedByHand()) === JSON.stringify([...realCounted, A, B].sort()));
} finally {
  await c.query("rollback").catch(() => {});
}

console.log("-- after ROLLBACK");
const end = await snapshot();
ok("every function back to the start", JSON.stringify(end.defs) === JSON.stringify(before.defs));
ok(alreadyNote(), NEW_FUNCTIONS.every((sig) => (end.defs[sig] === null) === (before.defs[sig] === null)));
ok("triggers identical", JSON.stringify(end.triggers) === JSON.stringify(before.triggers));
ok("profile counts, flags and every owner row identical", JSON.stringify(end.flags) === JSON.stringify(before.flags), end.flags.owners);
ok("counted owners identical", JSON.stringify(end.counted) === JSON.stringify(before.counted));
ok("auth.users count identical", end.authUsers === before.authUsers);
ok("no fixture accounts left", end.fixtures === 0);
ok("migration history untouched", end.migrations === before.migrations, end.migrations);
await c.end();

function alreadyNote() {
  return before.defs[NEW_FUNCTIONS[1]] === null ? "new functions gone again" : "new functions still there (already live)";
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED, EVERYTHING ROLLED BACK");
process.exit(failures ? 1 : 0);
