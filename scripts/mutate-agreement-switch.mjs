// Mutation proofs for the agreement switch (docusign-port, task 4).
//
//   node scripts/mutate-agreement-switch.mjs        (repo root; unit tests only, no database)
//
// Each mutation replaces ONE exact snippet (it must occur exactly once), runs
// the named test files, and must make them FAIL. The file is restored in a
// finally block, and its bytes are checked against the original afterwards.
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const B = "app/(customer)/book";
const T = {
  checkout: ["lib/bookings/checkout-agreement.test.ts", "lib/bookings/checkout-cutoff.test.ts", "lib/bookings/checkout-floor.test.ts", "lib/bookings/checkout-validation.test.ts"],
  args: ["lib/bookings/create-agreement-args.test.ts"],
  mode: ["lib/docusign/mode.test.ts"],
  actions: [`${B}/actions.test.ts`],
  page: [`${B}/page.test.tsx`],
  preflight: ["lib/docusign/preflight.test.ts"],
  save: ["lib/docusign/mode-settings.test.ts"],
  banner: ["app/(admin)/settings/_components/AgreementModeBanner.markup.test.tsx", "lib/docusign/mode.test.ts"],
  panel: ["app/(admin)/settings/_components/AgreementModeSettings.markup.test.tsx"],
  settingsPage: ["app/(admin)/settings/page.test.tsx"],
  settingsActions: ["app/(admin)/settings/actions-agreement.test.ts"],
  wizard: [`${B}/_components/AttestBookingWizard.snapshot.test.tsx`],
};

const MUTATIONS = [
  // checkout: the gate and the mode
  ["checkout: DocuSign gate runs in attest mode too", "lib/bookings/checkout.ts", 'const docusign = agreement.mode === "docusign";', "const docusign = true;", T.checkout],
  ["checkout: DocuSign mode skips the gate", "lib/bookings/checkout.ts", 'const docusign = agreement.mode === "docusign";', "const docusign = false;", T.checkout],
  ["checkout: gate result ignored", "lib/bookings/checkout.ts", "    if (!gate.ok) {\n", "    if (false && !gate.ok) {\n", T.checkout],
  ["checkout: no_email in attest mode too", "lib/bookings/checkout.ts", "if (docusign && !params.p_contact_email) {", "if (!params.p_contact_email) {", T.checkout],
  ["checkout: attest passes an (empty) session to createBooking", "lib/bookings/checkout.ts", ": await createBooking(params));", ": await createBooking(params, { agreementSessionId: undefined }));", T.checkout],
  ["checkout: DocuSign session not passed to createBooking", "lib/bookings/checkout.ts", "? await createBooking(params, { agreementSessionId: agreement.sessionId })", "? await createBooking(params)", T.checkout],
  ["create: session key always sent", "lib/bookings/create.ts", '...("agreementSessionId" in opts ? { p_agreement_session_id: opts.agreementSessionId ?? null } : {}),', "p_agreement_session_id: opts.agreementSessionId ?? null,", T.args],
  ["create: session key never sent", "lib/bookings/create.ts", '...("agreementSessionId" in opts ? { p_agreement_session_id: opts.agreementSessionId ?? null } : {}),', "", T.args],
  // the two keys
  ["mode: any CL_DOCUSIGN_ENABLED value counts", "lib/docusign/mode.ts", 'process.env.CL_DOCUSIGN_ENABLED?.trim() === "1"', "!!process.env.CL_DOCUSIGN_ENABLED", T.mode],
  ["mode: missing credentials ignored", "lib/docusign/mode.ts", "ok: enabled && missing.length === 0", "ok: enabled", T.mode],
  ["mode: one key is enough (|| for &&)", "lib/docusign/mode-shared.ts", 'setting === "docusign" && capability.ok === true', 'setting === "docusign" || capability.ok === true', T.mode],
  ["mode: setting alone switches", "lib/docusign/mode-shared.ts", 'setting === "docusign" && capability.ok === true', 'setting === "docusign"', T.mode],
  ["mode: setting read without the capability", "lib/docusign/mode.ts", '  if (!capability.ok) return "attest";\n', "", T.mode],
  ["mode: unreadable setting reads as docusign", "lib/docusign/mode.ts", "    if (error) return null;\n", '    if (error) return "docusign";\n', T.mode],
  ["mode: unexpected value passed through", "lib/docusign/mode.ts", "return isAgreementMode(data) ? data : null;", "return (data as AgreementMode) ?? null;", T.mode],
  ["mode: a throw is not caught", "lib/docusign/mode.ts", "  } catch {\n    return null;\n  }", "  } finally {\n  }", T.mode],
  // the action
  ["action: attest mode accepts a DocuSign page's payload", "app/(customer)/book/actions.ts", "    if (fromDocusignPage && !fromAttestPage) return { ok: false, ...MODE_CHANGED };\n", "", T.actions],
  ["action: DocuSign mode books an attest page on its checkbox", "app/(customer)/book/actions.ts", "  if (fromAttestPage && !fromDocusignPage) return { ok: false, ...MODE_CHANGED };\n", "", T.actions],
  ["action: attest checkbox not required", "app/(customer)/book/actions.ts", "    if (!input.agreementAcknowledged) {", "    if (false) {", T.actions],
  ["action: attest runs checkout in DocuSign mode", "app/(customer)/book/actions.ts", '{ token: paymentToken, idempotencyKey }, { mode: "attest" });', '{ token: paymentToken, idempotencyKey }, { mode: "docusign", sessionId: null });', T.actions],
  ["action: DocuSign checkout told attest", "app/(customer)/book/actions.ts", '{ mode: "docusign", sessionId: agreementSessionId },', '{ mode: "attest" },', T.actions],
  ["action: envelopes started in attest mode", "app/(customer)/book/actions.ts", '  if ((await effectiveAgreementMode()) !== "docusign") {\n    return { ok: false as const, ...MODE_CHANGED };\n  }\n', "", T.actions],
  ["action: verify in attest mode", "app/(customer)/book/actions.ts", '  if ((await effectiveAgreementMode()) !== "docusign") {\n    return { ok: false, code: MODE_CHANGED.code', '  if (false) {\n    return { ok: false, code: MODE_CHANGED.code', T.actions],
  // /book
  ["page: wizard choice inverted", "app/(customer)/book/page.tsx", '{mode === "docusign" ? (', '{mode !== "docusign" ? (', T.page],
  ["page: attest wizard without the PowerForm link", "app/(customer)/book/page.tsx", "docusignUrl={process.env.NEXT_PUBLIC_DOCUSIGN_URL ?? null}", "docusignUrl={null}", T.page],
  // preflight
  ["preflight: role match ignores case", "lib/docusign/preflight.ts", "const has = roles.includes(AGREEMENT_ROLE);", "const has = roles.some((r) => r.toLowerCase() === AGREEMENT_ROLE.toLowerCase());", T.preflight],
  ["preflight: carries on without credentials", "lib/docusign/preflight.ts", "  if (cap.missing.length) return done();\n", "", T.preflight],
  ["preflight: carries on after a failed sign-in", "lib/docusign/preflight.ts", '      detail: errText(e) + (consent ? " The impersonated user has to grant consent to the integration key first." : ""),\n    });\n    return done();', '      detail: errText(e) + (consent ? " The impersonated user has to grant consent to the integration key first." : ""),\n    });', T.preflight],
  ["preflight: switch step always ok", "lib/docusign/preflight.ts", "    ok: cap.enabled,", "    ok: true,", T.preflight],
  // owner save
  ["save: 0 rows taken as saved", "lib/docusign/mode-settings.ts", "  if (!Array.isArray(data) || data.length !== 1) {", "  if (!Array.isArray(data)) {", T.save],
  ["save: no owner check", "lib/docusign/mode-settings.ts", "  await assertOwner();\n", "", T.save],
  ["save: writes another column too", "lib/docusign/mode-settings.ts", ".update({ mode })", ".update({ mode, updated_by: null })", T.save],
  ["save: wrong table", "lib/docusign/mode-settings.ts", '.from("cl_agreement_settings")', '.from("cl_booking_settings")', T.save],
  // Settings actions and page
  ["Check DocuSign: not staff-only", "app/(admin)/settings/actions.ts", "    await assertStaff();\n", "", T.settingsActions],
  ["save message: claims DocuSign without the capability", "app/(admin)/settings/actions.ts", "      message: cap.ok\n", "      message: true\n", T.settingsActions],
  ["settings page: no banner", "app/(admin)/settings/page.tsx", "      <AgreementModeBanner status={agreement} />\n", "", T.settingsPage],
  // the attest wizard (users-page's, pinned by the byte-identical snapshot)
  ["wizard: checkbox no longer sent", "app/(customer)/book/_components/AttestBookingWizard.tsx", "      agreementAcknowledged: agreementAck,", "      agreementAcknowledged: true,", T.wizard],
  ["wizard: status text changed", "app/(customer)/book/_components/AttestBookingWizard.tsx", '{agreementAck ? "Acknowledged" : "Not signed"}', '{agreementAck ? "Signed" : "Not signed"}', T.wizard],
  ["wizard: PowerForm link dropped", "app/(customer)/book/_components/AttestBookingWizard.tsx", "        docusignUrl={docusignUrl}", "        docusignUrl={null}", T.wizard],
  // banner and panel
  ["banner: mismatch not a warning", "lib/docusign/mode-shared.ts", '  if (s.setting === "docusign") {\n    return {\n      tone: "warn",', '  if (s.setting === "docusign") {\n    return {\n      tone: "neutral",', T.banner],
  ["banner: shows DocuSign whenever the setting says so", "lib/docusign/mode-shared.ts", '  if (s.effective === "docusign") {', '  if (s.setting === "docusign") {', T.banner],
  ["panel: staff get the radios", "app/(admin)/settings/_components/AgreementModeSettings.tsx", ") : canEdit ? (", ") : true ? (", T.panel],
];

const only = process.argv[2];
let survived = 0;
let caught = 0;
for (const [label, file, from, to, tests] of MUTATIONS) {
  if (only && !label.includes(only)) continue;
  const original = fs.readFileSync(file);
  const text = original.toString("utf8").replace(/\r\n/g, "\n");
  const n = text.split(from).length - 1;
  if (n !== 1) {
    console.log(`BAD   ${label}: snippet matched ${n} times in ${file}`);
    survived++;
    continue;
  }
  try {
    // A function, so "$" patterns in the replacement are taken literally.
    fs.writeFileSync(file, text.replace(from, () => to));
    const r = spawnSync("npx", ["vitest", "run", ...tests], { encoding: "utf8", shell: true, env: { ...process.env, NODE_OPTIONS: "--use-system-ca" } });
    const failed = r.status !== 0;
    console.log(`${failed ? "CAUGHT" : "SURVIVED"}  ${label}`);
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
console.log(`\n${caught} caught, ${survived} survived or bad`);
process.exit(survived ? 1 : 0);
