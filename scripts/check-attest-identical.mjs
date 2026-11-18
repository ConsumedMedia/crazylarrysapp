// Read-only proof that attest mode is users-page's /book and /pay agreement
// code, unchanged but for the listed renames (docusign-port, task 4).
//
//   node scripts/check-attest-identical.mjs [ref]      (repo root; ref defaults to users-page)
//
// Reads blobs with `git show <ref>:<path>` (changes nothing), applies ONLY the
// substitutions listed below to the users-page text, and requires the result
// to equal the working file exactly (line endings normalized to LF). Any other
// difference, a substitution that no longer matches, or one that matches more
// than once, fails.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const REF = process.argv[2] || "users-page";
const lf = (s) => s.replace(/\r\n/g, "\n");
const show = (p) => lf(execFileSync("git", ["show", `${REF}:${p}`], { encoding: "utf8", maxBuffer: 1 << 26 }));

const B = "app/(customer)/book/_components";
const CASES = [
  {
    file: `${B}/AttestBookingWizard.tsx`,
    from: `${B}/BookingWizard.tsx`,
    subs: [
      ['import { AgreementModal } from "./AgreementModal";', 'import { AttestAgreementModal as AgreementModal } from "./AttestAgreementModal";'],
      ["export function BookingWizard({", "export function AttestBookingWizard({"],
    ],
  },
  {
    file: `${B}/AttestAgreementModal.tsx`,
    from: `${B}/AgreementModal.tsx`,
    subs: [
      [
        '"use client";\n\n',
        '"use client";\n\n// The PowerForm-and-checkbox agreement step: users-page\'s AgreementModal,\n// unchanged but for its name. Attest mode uses it on /book\n// (AttestBookingWizard) and on /pay; AgreementModal is DocuSign signing.\n\n',
      ],
      ["export function AgreementModal({", "export function AttestAgreementModal({"],
    ],
  },
  {
    file: "app/(customer)/pay/[token]/PayLinkForm.tsx",
    from: "app/(customer)/pay/[token]/PayLinkForm.tsx",
    subs: [[
      'import { AgreementModal } from "@/app/(customer)/book/_components/AgreementModal";',
      'import { AttestAgreementModal as AgreementModal } from "@/app/(customer)/book/_components/AttestAgreementModal";',
    ]],
  },
];

let failures = 0;
for (const c of CASES) {
  let text = show(c.from);
  const problems = [];
  for (const [a, b] of c.subs) {
    const n = text.split(a).length - 1;
    if (n !== 1) problems.push(`substitution matched ${n} times: ${a.slice(0, 60)}`);
    else text = text.replace(a, b);
  }
  const actual = lf(fs.readFileSync(c.file, "utf8"));
  if (text !== actual) {
    const x = text.split("\n");
    const y = actual.split("\n");
    const i = x.findIndex((l, k) => l !== y[k]);
    problems.push(`differs at line ${i + 1}: ${REF} ${JSON.stringify(x[i]?.slice(0, 100))} vs working ${JSON.stringify(y[i]?.slice(0, 100))}`);
  }
  const ok = problems.length === 0;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.file} = ${REF}:${c.from} + ${c.subs.length} listed rename(s)`);
  for (const p of problems) console.log(`      ${p}`);
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
