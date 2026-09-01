import type { Config } from "tailwindcss";

/**
 * Colors ported verbatim from
 * design-reference/Crazy Larry's Dumpsters Platform/cl-tokens.css
 *
 * - Brand scale hexes are hard-coded (identical in light and dark).
 * - Theme-dependent surface/ink/line tokens are exposed as CSS custom
 *   properties (defined in app/globals.css) so a single class works in
 *   both themes.
 */
const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // --- Brand scale (verbatim, theme-independent) ---
        pink: { DEFAULT: "#e91e8c", 700: "#b3126a", 100: "#fde4f1" },
        teal: { DEFAULT: "#14b5a8", 700: "#0b7d74", 100: "#d6f5f2" },
        orange: { DEFAULT: "#ff6b1a", 700: "#a83d00", 100: "#ffe8d9" },
        purple: { DEFAULT: "#8b4fd0", 700: "#5c2e91", 100: "#ece0fa" },
        "gray-st": "#7d8592",

        // --- Theme tokens (resolved via CSS vars in globals.css) ---
        bg: "var(--cl-bg)",
        surface: "var(--cl-surface)",
        "surface-2": "var(--cl-surface-2)",
        ink: "var(--cl-ink)",
        "ink-2": "var(--cl-ink-2)",
        "ink-3": "var(--cl-ink-3)",
        line: "var(--cl-line)",
        "line-strong": "var(--cl-line-strong)",
        tint: "var(--cl-tint)",
        "rail-bg": "var(--cl-rail-bg)",
        "rail-ink": "#ffffff",
        "rail-ink-2": "#8b929e",

        "pink-tint": "var(--cl-pink-tint)",
        "pink-tint-ink": "var(--cl-pink-tint-ink)",
        "teal-tint": "var(--cl-teal-tint)",
        "teal-tint-ink": "var(--cl-teal-tint-ink)",
        "purple-tint": "var(--cl-purple-tint)",
        "purple-tint-ink": "var(--cl-purple-tint-ink)",
        "orange-tint": "var(--cl-orange-tint)",
        "orange-tint-ink": "var(--cl-orange-tint-ink)",
      },
      fontFamily: {
        sans: ['"Archivo"', "system-ui", "sans-serif"],
      },
      borderRadius: {
        none: "0",
        DEFAULT: "0",
      },
    },
  },
  plugins: [],
};
export default config;
