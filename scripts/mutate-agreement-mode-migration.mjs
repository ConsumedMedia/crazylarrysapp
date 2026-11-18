// Mutation proofs for supabase/migrations/20261117000000_agreement_mode.sql.
//
//   node --use-system-ca scripts/mutate-agreement-mode-migration.mjs     (repo root)
//
// Each mutant is written to the OS temp directory (the migration file itself
// is never touched) and run through scripts/probe-agreement-mode.mjs with
// PROBE_MIGRATION. The probe always rolls back, so nothing reaches the live
// database; every mutant must make it FAIL.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SRC = "supabase/migrations/20261117000000_agreement_mode.sql";
const original = fs.readFileSync(SRC, "utf8").replace(/\r\n/g, "\n");

const MUTANTS = [
  // the table
  ["default docusign", "mode       text not null default 'attest',", "mode       text not null default 'docusign',"],
  ["nullable", "mode       text not null default 'attest',", "mode       text default 'attest',"],
  ["no mode check", ",\n  constraint cl_agreement_settings_mode_check check (mode in ('attest', 'docusign'))", ""],
  ["not a singleton (no id check)", "id         boolean primary key default true check (id),", "id         boolean primary key default true,"],
  ["row seeded as docusign", "insert into public.cl_agreement_settings (id) values (true);", "insert into public.cl_agreement_settings (id, mode) values (true, 'docusign');"],
  ["no row seeded", "insert into public.cl_agreement_settings (id) values (true);\n", ""],
  ["RLS off", "alter table public.cl_agreement_settings enable row level security;\n", "alter table public.cl_agreement_settings disable row level security;\n"],
  ["anyone authenticated updates", "for update to authenticated using (public.is_owner()) with check (public.is_owner());", "for update to authenticated using (true) with check (true);"],
  ["staff read becomes everyone read", "for select to authenticated using (public.is_staff());", "for select to authenticated using (true);"],
  ["no column grant for owners", "grant update (mode) on public.cl_agreement_settings to authenticated;\n", ""],
  ["whole-table update for authenticated", "grant update (mode) on public.cl_agreement_settings to authenticated;", "grant update on public.cl_agreement_settings to authenticated;"],
  ["anon gets select", "grant select on public.cl_agreement_settings to authenticated;", "grant select on public.cl_agreement_settings to authenticated, anon;"],
  ["authenticated may insert and delete", "grant select on public.cl_agreement_settings to authenticated;", "grant select, insert, delete on public.cl_agreement_settings to authenticated;"],
  ["no updated_at trigger", "create trigger cl_agreement_settings_set_updated_at\n  before update on public.cl_agreement_settings\n  for each row execute function public.set_updated_at();\n", ""],
  ["no stamp trigger", "create trigger cl_agreement_settings_stamp\n  before update on public.cl_agreement_settings\n  for each row execute function public._stamp_agreement_settings();\n", ""],
  ["stamp callable by service_role", "revoke all on function public._stamp_agreement_settings() from public, anon, authenticated, service_role;", "revoke all on function public._stamp_agreement_settings() from public, anon, authenticated;"],
  // the function
  ["function returns the raw column (row missing -> null)", "  select case\n    when (select s.mode from public.cl_agreement_settings s where s.id) = 'docusign'\n      then 'docusign'\n    else 'attest'\n  end", "  select (select s.mode from public.cl_agreement_settings s where s.id)"],
  ["function defaults to docusign", "    else 'attest'\n  end", "    else 'docusign'\n  end"],
  ["function invoker", "stable\nsecurity definer\nset search_path = public\nas $$\n  -- DEFINER", "stable\nsecurity invoker\nset search_path = public\nas $$\n  -- DEFINER"],
  ["function executable by authenticated", "grant execute on function public.booking_agreement_mode() to service_role;", "grant execute on function public.booking_agreement_mode() to service_role, authenticated;"],
  ["function without search_path", "stable\nsecurity definer\nset search_path = public\nas $$\n  -- DEFINER", "stable\nsecurity definer\nas $$\n  -- DEFINER"],
  // Not listed: dropping `revoke all ... from public, anon, authenticated` on
  // booking_agreement_mode is an equivalent mutant here. The postgres role's
  // default privileges for new functions (private by default, 20260924000000)
  // are already postgres + service_role only, so the ACL comes out the same
  // (checked 2026-11-17: it survived). The revoke stays as a guard in case
  // those defaults change; the probe pins the exact ACL either way.
  // collateral
  ["also flips the cutoff on", "grant update (mode) on public.cl_agreement_settings to authenticated;", "grant update (mode) on public.cl_agreement_settings to authenticated;\nupdate public.cl_booking_settings set cutoff_enabled = true;"],
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agreement-mode-mutants-"));
let survived = 0;
let caught = 0;
for (const [label, from, to] of MUTANTS) {
  const n = original.split(from).length - 1;
  if (n !== 1) {
    console.log(`BAD       ${label}: snippet matched ${n} times`);
    survived++;
    continue;
  }
  const file = path.join(dir, `${label.replace(/[^a-z0-9]+/gi, "-")}.sql`);
  // A function, so "$$" in the replacement stays "$$" (a string would turn it into "$").
  fs.writeFileSync(file, original.replace(from, () => to));
  const r = spawnSync(process.execPath, ["--use-system-ca", "scripts/probe-agreement-mode.mjs"], {
    encoding: "utf8",
    env: { ...process.env, PROBE_MIGRATION: file },
  });
  const failed = r.status !== 0;
  const lines = (r.stdout + r.stderr).split("\n");
  const firstFail = lines.find((l) => l.startsWith("FAIL")) ?? lines.find((l) => /^error|Error:/.test(l)) ?? "";
  console.log(`${failed ? "CAUGHT  " : "SURVIVED"}  ${label}${failed ? `   <- ${firstFail.slice(0, 110)}` : ""}`);
  if (failed) caught++;
  else survived++;
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${caught} caught, ${survived} survived or bad`);
process.exit(survived ? 1 : 0);
