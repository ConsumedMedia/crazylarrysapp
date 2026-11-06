/**
 * A tiny in-memory stand-in for the parts of supabase-js the customer search
 * uses: select / eq / neq / in / ilike / order / limit / maybeSingle, head
 * counts, and awaiting the builder. ILIKE follows Postgres semantics,
 * including backslash-escaped % and _ (so escaping is really tested).
 * Every call is recorded in `calls` for assertions.
 */
export type Rows = Record<string, Array<Record<string, unknown>>>;

export function likeToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (ch === "%") re += ".*";
    else if (ch === "_") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "is");
}

export function fakeSupabase(tables: Rows, opts: { failOn?: (table: string) => { code: string; message: string } | null } = {}) {
  const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
  const client = {
    from(table: string) {
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      let order: { col: string; asc: boolean } | null = null;
      let limit = Infinity;
      let head = false;
      let wantCount = false;
      const rec = (op: string, args: unknown[]) => calls.push({ table, op, args });
      const b: Record<string, unknown> = {};
      b.select = (cols: string, o?: { count?: string; head?: boolean }) => {
        rec("select", [cols, o]);
        head = !!o?.head;
        wantCount = o?.count === "exact";
        return b;
      };
      b.eq = (c: string, v: unknown) => (rec("eq", [c, v]), filters.push((r) => r[c] === v), b);
      b.neq = (c: string, v: unknown) => (rec("neq", [c, v]), filters.push((r) => r[c] !== v), b);
      b.in = (c: string, vs: unknown[]) => (rec("in", [c, vs]), filters.push((r) => vs.includes(r[c])), b);
      b.ilike = (c: string, p: string) => {
        rec("ilike", [c, p]);
        const re = likeToRegExp(p);
        filters.push((r) => typeof r[c] === "string" && re.test(r[c] as string));
        return b;
      };
      b.order = (c: string, o?: { ascending?: boolean }) => (rec("order", [c, o]), (order = { col: c, asc: o?.ascending !== false }), b);
      b.limit = (n: number) => (rec("limit", [n]), (limit = n), b);
      const run = () => {
        const fail = opts.failOn?.(table);
        if (fail) return { data: null, error: fail, count: null };
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (order) {
          const { col, asc } = order;
          rows = [...rows].sort((a, z) => (String(a[col]) < String(z[col]) ? -1 : String(a[col]) > String(z[col]) ? 1 : 0) * (asc ? 1 : -1));
        }
        const count = rows.length;
        rows = rows.slice(0, limit);
        return { data: head ? null : rows, error: null, count: wantCount ? count : null };
      };
      b.maybeSingle = async () => {
        const r = run();
        return { data: r.data?.[0] ?? null, error: r.error };
      };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej);
      return b;
    },
  };
  return { client, calls };
}
