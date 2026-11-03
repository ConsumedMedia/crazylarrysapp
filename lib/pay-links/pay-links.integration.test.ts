/**
 * Read-only checks against the real database (shared with production):
 *   CL_RUN_DB_TESTS=1 npx vitest run lib/pay-links/pay-links.integration.test.ts
 *
 * Each runs in a READ ONLY transaction that is rolled back. Nothing is written.
 *
 *  1. No live pay-link token appears anywhere in notifications_log (body or
 *     error). A token is live while its link is 'active'. scripts/probe-pay-links.mjs
 *     proved this query catches a planted token.
 *  2. Hidden owners (e.g. seed-owner@crazylarrys.test) are never staff-alert
 *     recipients, chosen or fallback; every fallback recipient is a visible,
 *     unremoved owner.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, type PoolClient } from "pg";

const RUN = process.env.CL_RUN_DB_TESTS === "1";

describe.skipIf(!RUN)("pay links against the real database (read only)", () => {
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

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("no live pay-link token is stored in notifications_log", async () => {
    const live = await readOnly(async (c) =>
      (await c.query(`
        with cand as (
          select n.id, m[1] as token
            from public.notifications_log n,
                 regexp_matches(coalesce(n.body, '') || ' ' || coalesce(n.error, ''), '/pay/([A-Za-z0-9_-]{43})', 'g') m
        )
        select cand.id::text from cand
          join public.pay_links l on l.token_hash = public._pay_link_hash(cand.token)
         where l.status = 'active'`)).rows,
    );
    expect(live).toEqual([]);
  });

  it("hidden owners are never staff-alert recipients; fallback recipients are visible owners", async () => {
    const { recipients, hidden, owners } = await readOnly(async (c) => {
      await c.query("set local role service_role");
      const recipients = (await c.query(`select profile_id::text, via_fallback from public.pay_link_staff_alert_recipients()`)).rows as Array<{ profile_id: string; via_fallback: boolean }>;
      await c.query("reset role");
      const hidden = (await c.query(`select id::text from public.profiles where hidden_from_users`)).rows.map((r) => r.id as string);
      const owners = (await c.query(`select id::text from public.profiles where role = 'owner' and removed_at is null and not hidden_from_users`)).rows.map((r) => r.id as string);
      return { recipients, hidden, owners };
    });
    expect(recipients.length).toBeGreaterThan(0);
    for (const r of recipients) {
      expect(hidden, r.profile_id).not.toContain(r.profile_id);
      if (r.via_fallback) expect(owners).toContain(r.profile_id);
    }
  });
});
