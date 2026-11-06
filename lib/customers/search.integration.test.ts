/**
 * Read-only checks of the customer search against the real database (shared
 * with production):
 *   CL_RUN_DB_TESTS=1 npx vitest run lib/customers/search.integration.test.ts
 *
 * One READ ONLY transaction per test, rolled back. Runs the library's queries
 * (same columns, same ILIKE patterns from search-shared.ts) as role
 * authenticated with a visible owner's JWT claim, and as a driver and anon to
 * show what RLS alone would allow. Assertions use ids and counts only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, type PoolClient } from "pg";
import { digitsOf, escapeLike, last10, phoneLikePattern, phoneMatches, CANDIDATE_LIMIT } from "./search-shared";

const RUN = process.env.CL_RUN_DB_TESTS === "1";
const COLS = "id, full_name, phone, email, company_name, sms_consent";

describe.skipIf(!RUN)("customer search against the real database (read only)", () => {
  let pool: Pool;
  const readOnly = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query("begin transaction read only");
      return await fn(c);
    } finally {
      await c.query("rollback");
      c.release();
    }
  };
  const asSession = async (c: PoolClient, claims: Record<string, string>) => {
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await c.query(claims.role === "anon" ? "set local role anon" : "set local role authenticated");
  };

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("as staff: each stored phone format is found by its last 10 digits typed another way, and only that customer", async () => {
    const results = await readOnly(async (c) => {
      const owner = (await c.query(`select id::text from public.profiles where role='owner' and removed_at is null and not hidden_from_users limit 1`)).rows[0].id;
      const all = (await c.query(`select id::text, phone from public.customers where phone is not null`)).rows as Array<{ id: string; phone: string }>;
      await asSession(c, { sub: owner, role: "authenticated" });
      const out: Array<{ id: string; found: string[] }> = [];
      for (const target of all) {
        const typed = `+1 (${last10(target.phone).slice(0, 3)}) ${last10(target.phone).slice(3, 6)}-${last10(target.phone).slice(6)}`;
        const d = digitsOf(typed);
        const rows = (await c.query(`select ${COLS} from public.customers where phone ilike $1 limit ${CANDIDATE_LIMIT}`, [phoneLikePattern(d)])).rows as Array<{ id: string; phone: string }>;
        out.push({ id: target.id, found: rows.filter((r) => phoneMatches(r.phone, d)).map((r) => r.id) });
      }
      return out;
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.found, r.id.slice(0, 8)).toContain(r.id);
    // last-10 collisions would show as extra ids; there are none today
    expect(results.every((r) => r.found.length === 1)).toBe(true);
  });

  it("as staff: a name fragment matches case-insensitively; % and _ are literal", async () => {
    const r = await readOnly(async (c) => {
      const owner = (await c.query(`select id::text from public.profiles where role='owner' and removed_at is null and not hidden_from_users limit 1`)).rows[0].id;
      const one = (await c.query(`select id::text, full_name from public.customers where length(full_name) >= 6 order by created_at limit 1`)).rows[0];
      await asSession(c, { sub: owner, role: "authenticated" });
      const frag = one.full_name.slice(1, 5).toUpperCase();
      const found = (await c.query(`select id::text from public.customers where full_name ilike $1 limit ${CANDIDATE_LIMIT}`, [`%${escapeLike(frag)}%`])).rows.map((x) => x.id);
      const wild = (await c.query(`select count(*)::int n from public.customers where full_name ilike $1`, [`%${escapeLike("%_")}%`])).rows[0].n;
      return { id: one.id, found, wild };
    });
    expect(r.found).toContain(r.id);
    expect(r.wild).toBe(0);
  });

  it("RLS alone: a driver sees only customers on their own jobs, anon nothing — the action's staff check is what keeps the list staff-only", async () => {
    const r = await readOnly(async (c) => {
      const drv = (await c.query(`select d.profile_id::text pid, (select count(distinct b.customer_id)::int from public.jobs j join public.bookings b on b.id = j.booking_id where j.driver_id = d.id) n
          from public.drivers d where d.active and d.profile_id is not null order by 2 desc limit 1`)).rows[0];
      const total = (await c.query(`select count(*)::int n from public.customers`)).rows[0].n;
      await c.query("savepoint s");
      await asSession(c, { sub: drv.pid, role: "authenticated" });
      const driverSees = (await c.query(`select count(*)::int n from public.customers`)).rows[0].n;
      await c.query("rollback to savepoint s");
      await asSession(c, { role: "anon" });
      let anon: number | string;
      try {
        anon = (await c.query(`select count(*)::int n from public.customers`)).rows[0].n;
      } catch (e) {
        anon = (e as { code: string }).code;
      }
      return { total, driverSees, driverOwn: drv.n, anon };
    });
    expect(r.driverSees).toBe(r.driverOwn);
    expect(r.driverSees).toBeLessThan(r.total);
    expect([0, "42501"]).toContain(r.anon);
  });
});
