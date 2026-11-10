/**
 * Test mode: where a text or an email goes while notifications are being
 * tested. Pure (reads only the env object it is given), so the send layer,
 * the Settings warnings and tests share one set of rules.
 *
 *   CL_NOTIFICATIONS_TEST_PHONE  redirects texts
 *   CL_NOTIFICATIONS_TEST_EMAIL  redirects emails
 *   CL_NOTIFICATIONS_TEST_TO     the old single variable: redirects only the
 *                                channel its value looks like (an address with
 *                                "@" redirects emails, anything else texts)
 *
 * Rules:
 *  - Test mode is ON when ANY of the three is set (non-blank), even if the
 *    value is unusable. A bad value never turns test mode off.
 *  - In test mode a channel goes only to its own test target, never to the
 *    customer. The new variable wins over CL_NOTIFICATIONS_TEST_TO.
 *  - A value that is the wrong shape, or a reserved fictional contact
 *    (example.com, 555-01xx), counts as missing. The next candidate is tried.
 *  - No usable target: the channel is skipped, and the reason names the
 *    variable to set. Never sent to the customer.
 * The reasons never include the values themselves.
 */
import { toE164US } from "./phone";
import { isReservedEmail, isReservedPhone } from "./reserved";

export const TEST_PHONE_VAR = "CL_NOTIFICATIONS_TEST_PHONE";
export const TEST_EMAIL_VAR = "CL_NOTIFICATIONS_TEST_EMAIL";
export const TEST_TO_VAR = "CL_NOTIFICATIONS_TEST_TO";
const TEST_VARS = [TEST_PHONE_VAR, TEST_EMAIL_VAR, TEST_TO_VAR] as const;

export type TestChannel = "sms" | "email";
type Env = Record<string, string | undefined>;

export type RedirectDecision =
  /** No test variable set: send to the intended recipient. */
  | { mode: "live" }
  /** Test mode: send here instead. `via` is the variable it came from. */
  | { mode: "redirect"; to: string; via: string }
  /**
   * Test mode with no usable target for this channel: don't send.
   * category 'test_mode' = nothing set for it; 'not_configured' = something
   * was set but is the wrong shape or reserved (a human should fix the env).
   */
  | { mode: "skip"; category: "test_mode" | "not_configured"; reason: string };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function value(env: Env, name: string): string {
  return (env[name] ?? "").trim();
}

export function testModeOn(env: Env = process.env): boolean {
  return TEST_VARS.some((n) => value(env, n) !== "");
}

type Candidate = { via: string; raw: string };
type Checked = { ok: true; to: string } | { ok: false; problem: string };

function checkPhone(raw: string): Checked {
  const e164 = raw.includes("@") ? null : toE164US(raw);
  if (!e164) return { ok: false, problem: "is not a valid US number" };
  if (isReservedPhone(e164)) return { ok: false, problem: "is a reserved test number (555-01xx)" };
  return { ok: true, to: e164 };
}

function checkEmail(raw: string): Checked {
  if (!EMAIL.test(raw)) return { ok: false, problem: "is not a valid email address" };
  if (isReservedEmail(raw)) return { ok: false, problem: "is a reserved test address (example.com/.net/.org)" };
  return { ok: true, to: raw };
}

/** The candidates for one channel, in priority order. */
function candidates(channel: TestChannel, env: Env): Candidate[] {
  const own = channel === "sms" ? TEST_PHONE_VAR : TEST_EMAIL_VAR;
  const out: Candidate[] = [];
  if (value(env, own)) out.push({ via: own, raw: value(env, own) });
  // The old variable serves only the channel its value looks like.
  const old = value(env, TEST_TO_VAR);
  if (old && old.includes("@") === (channel === "email")) out.push({ via: TEST_TO_VAR, raw: old });
  return out;
}

/** Where this channel's message goes right now. */
export function resolveTestRedirect(channel: TestChannel, env: Env = process.env): RedirectDecision {
  if (!testModeOn(env)) return { mode: "live" };
  const own = channel === "sms" ? TEST_PHONE_VAR : TEST_EMAIL_VAR;
  const what = channel === "sms" ? "SMS" : "email";
  const problems: string[] = [];
  for (const c of candidates(channel, env)) {
    const checked = channel === "sms" ? checkPhone(c.raw) : checkEmail(c.raw);
    if (checked.ok) return { mode: "redirect", to: checked.to, via: c.via };
    problems.push(`${c.via} ${checked.problem}`);
  }
  if (problems.length) {
    return {
      mode: "skip",
      category: "not_configured",
      reason: `test mode: ${what} not sent — ${problems.join("; ")}. Set ${own} to a usable test ${channel === "sms" ? "number" : "address"}`,
    };
  }
  return {
    mode: "skip",
    category: "test_mode",
    reason: `test mode: ${what} skipped — ${own} is not set${channel === "sms" && value(env, TEST_TO_VAR) ? ` (${TEST_TO_VAR} is an email address)` : ""}${channel === "email" && value(env, TEST_TO_VAR) ? ` (${TEST_TO_VAR} is a phone number)` : ""}`,
  };
}

/** Whether a new test variable holds a usable value (for the Settings warnings). */
export function testVarUsable(name: typeof TEST_PHONE_VAR | typeof TEST_EMAIL_VAR, env: Env = process.env): boolean {
  const raw = value(env, name);
  if (!raw) return false;
  return (name === TEST_PHONE_VAR ? checkPhone(raw) : checkEmail(raw)).ok;
}

export function testVarSet(name: string, env: Env = process.env): boolean {
  return value(env, name) !== "";
}
