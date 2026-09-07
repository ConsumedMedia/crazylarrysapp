"use client";

import { useState } from "react";
import { THEME_COOKIE, type ThemeChoice } from "./theme";

const OPTIONS: Array<{ value: ThemeChoice | "system"; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/**
 * Three-way Light/Dark/System control. Persists via a cookie (not
 * localStorage) so the root layout can read it server-side and set
 * data-cl-theme before first paint — no flash of the wrong theme.
 * `initialChoice` comes from the server (getThemeChoice()) so this
 * component's own highlighted-option state is correct on first render too.
 */
export function ThemeToggle({
  initialChoice,
  className = "",
}: {
  initialChoice: ThemeChoice | undefined;
  className?: string;
}) {
  const [choice, setChoice] = useState<ThemeChoice | "system">(initialChoice ?? "system");

  function choose(next: ThemeChoice | "system") {
    setChoice(next);
    if (next === "system") {
      document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
      document.documentElement.removeAttribute("data-cl-theme");
    } else {
      document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; SameSite=Lax`;
      document.documentElement.setAttribute("data-cl-theme", next);
    }
  }

  return (
    <div className={`flex border-2 border-line ${className}`}>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => choose(o.value)}
          aria-pressed={choice === o.value}
          className={`cl-btn flex-1 px-2 py-1.5 text-[10px] font-extrabold uppercase tracking-[0.06em] ${
            choice === o.value ? "bg-ink text-surface" : "text-ink-2 hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
