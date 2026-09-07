/** Client-and-server-safe theme constants — no "server-only" here since the
 *  client ThemeToggle needs THEME_COOKIE/isThemeChoice too. The actual
 *  cookies() read lives in theme.server.ts. */
export const THEME_COOKIE = "cl-theme";

export type ThemeChoice = "light" | "dark";

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return v === "light" || v === "dark";
}
