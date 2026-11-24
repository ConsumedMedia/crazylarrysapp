// Mutation proofs for the DocuSign return-URL origin (docusign-port).
//
//   node scripts/mutate-return-origin.mjs        (repo root; unit tests only, no database, no DocuSign)
//
// Each mutation replaces ONE exact snippet (it must occur exactly once), runs
// the named test files, and must make them FAIL. Every mutated file is hashed
// (sha256) before the run; it is restored in a finally block and its bytes
// must match afterwards, or the runner stops.
import fs from "node:fs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const RO = "lib/docusign/return-origin.ts";
const AG = "lib/docusign/agreement.ts";
const AC = "app/(customer)/book/actions.ts";
const T = {
  origin: ["lib/docusign/return-origin.test.ts"],
  agreement: ["lib/docusign/agreement-return-url.test.ts"],
  action: ["app/(customer)/book/actions.test.ts"],
};

const MUTATIONS = [
  // the allowlist
  ["any host allowed", RO, "return allowed.includes(host) ? `https://${host}`", "return true ? `https://${host}`", T.origin],
  ["suffix match instead of exact (evil-app.<domain>)", RO, "return allowed.includes(host) ?", "return allowed.some((a) => a !== null && host.endsWith(a)) ?", T.origin],
  ["NEXT_PUBLIC_SITE_URL host not allowed", RO, "[hostOf(env.NEXT_PUBLIC_SITE_URL), ", "[", T.origin],
  ["VERCEL_URL not allowed", RO, "hostOf(env.VERCEL_URL), ", "", T.origin],
  ["VERCEL_BRANCH_URL not allowed", RO, ", hostOf(env.VERCEL_BRANCH_URL)]", "]", T.origin],
  ["port ignored on allowed hosts", RO, "const host = requestHost?.split(\",\")[0].trim().toLowerCase() ?? \"\";", "const host = (requestHost?.split(\",\")[0].trim().toLowerCase() ?? \"\").replace(/:\\d+$/, \"\");", T.origin],
  // https only, except localhost
  ["allowed hosts get http", RO, "allowed.includes(host) ? `https://${host}`", "allowed.includes(host) ? `http://${host}`", T.origin],
  ["localhost gets https", RO, ": `http://${host}`;", ": `https://${host}`;", T.origin],
  // localhost only outside production
  ["localhost allowed in production", RO, "return env.NODE_ENV === \"production\" ? fallbackReturnOrigin(env) : `http://${host}`;", "return `http://${host}`;", T.origin],
  ["localhost refused in development too", RO, "return env.NODE_ENV === \"production\" ? fallbackReturnOrigin(env) : `http://${host}`;", "return fallbackReturnOrigin(env);", T.origin],
  // reading the header
  ["proxy list: last host used", RO, "requestHost?.split(\",\")[0]", "requestHost?.split(\",\").slice(-1)[0]", T.origin],
  ["case not folded", RO, "requestHost?.split(\",\")[0].trim().toLowerCase()", "requestHost?.split(\",\")[0].trim()", T.origin],
  ["host read before x-forwarded-host", RO, "h.get(\"x-forwarded-host\") ?? h.get(\"host\")", "h.get(\"host\") ?? h.get(\"x-forwarded-host\")", T.origin],
  ["headers() outside a request not caught", RO, "  try {\n    h = headers();\n  } catch {\n    return fallbackReturnOrigin();\n  }", "  h = headers();", T.origin],
  // the fallback
  ["fallback keeps trailing slashes", RO, "\"http://localhost:3000\").replace(/\\/+$/, \"\")", "\"http://localhost:3000\")", T.origin],
  ["fallback default changed", RO, "(env.NEXT_PUBLIC_SITE_URL ?? \"http://localhost:3000\")", "(env.NEXT_PUBLIC_SITE_URL ?? \"https://localhost:3000\")", T.origin],
  // where the return URL is built
  ["agreement: default origin no longer NEXT_PUBLIC_SITE_URL", AG, "origin: string = fallbackReturnOrigin()", "origin: string = \"http://localhost:3000\"", T.agreement],
  ["agreement: reused session ignores the origin", AG, "returnUrl: agreementReturnUrl(s.id, opts.returnOrigin),", "returnUrl: agreementReturnUrl(s.id),", T.agreement],
  ["agreement: new session ignores the origin", AG, "returnUrl: agreementReturnUrl(sessionId, opts.returnOrigin),", "returnUrl: agreementReturnUrl(sessionId),", T.agreement],
  // the action
  ["action: no origin passed", AC, "    returnOrigin: requestReturnOrigin(),\n", "", T.action],
  ["action: always NEXT_PUBLIC_SITE_URL (the Preview bug)", AC, "returnOrigin: requestReturnOrigin(),", "returnOrigin: process.env.NEXT_PUBLIC_SITE_URL,", T.action],
];

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const files = [...new Set(MUTATIONS.map((m) => m[1]))];
const before = Object.fromEntries(files.map((f) => [f, sha(fs.readFileSync(f))]));

const only = process.argv[2];
let survived = 0;
let caught = 0;
for (const [label, file, from, to, tests] of MUTATIONS) {
  if (only && !label.includes(only)) continue;
  const original = fs.readFileSync(file);
  const text = original.toString("utf8").replace(/\r\n/g, "\n");
  const n = text.split(from).length - 1;
  if (n !== 1) {
    console.log(`BAD       ${label}: snippet matched ${n} times in ${file}`);
    survived++;
    continue;
  }
  try {
    // A function, so "$" patterns in the replacement are taken literally.
    fs.writeFileSync(file, text.replace(from, () => to));
    const r = spawnSync("npx", ["vitest", "run", ...tests.map((t) => `"${t}"`)], { encoding: "utf8", shell: true });
    const failed = r.status !== 0;
    console.log(`${failed ? "CAUGHT  " : "SURVIVED"}  ${label}`);
    if (failed) caught++;
    else survived++;
  } finally {
    fs.writeFileSync(file, original);
  }
  if (!fs.readFileSync(file).equals(original)) {
    console.log(`!! ${file} not restored`);
    process.exit(2);
  }
}
for (const f of files) {
  const now = sha(fs.readFileSync(f));
  console.log(`${now === before[f] ? "RESTORED" : "CHANGED!"}  ${f}  sha256 ${now.slice(0, 16)}`);
  if (now !== before[f]) process.exit(2);
}
console.log(`\n${caught} caught, ${survived} survived or bad`);
process.exit(survived ? 1 : 0);
