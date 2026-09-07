import "server-only";
import { cookies } from "next/headers";
import { THEME_COOKIE, isThemeChoice, type ThemeChoice } from "./theme";

/**
 * The user's explicit override, if any — undefined means "no override, let
 * @media (prefers-color-scheme) decide" (see globals.css). Read once per
 * request and passed down; never call this from a client component.
 */
export function getThemeChoice(): ThemeChoice | undefined {
  const v = cookies().get(THEME_COOKIE)?.value;
  return isThemeChoice(v) ? v : undefined;
}
