/**
 * Brand hexes — verbatim from
 * design-reference/Crazy Larry's Dumpsters Platform/cl-tokens.css
 *
 * Use these only where a literal color value is unavoidable (SVG fills,
 * conic-gradient stops, dynamic border colors). Everywhere else use the
 * Tailwind token classes (bg-teal, text-orange, border-line, …).
 */
export const BRAND_HEX = {
  pink: "#e91e8c",
  teal: "#14b5a8",
  orange: "#ff6b1a",
  purple: "#8b4fd0",
  "gray-st": "#7d8592",
} as const;

export type BrandColor = keyof typeof BRAND_HEX;

import type { DumpsterStatus } from "@/lib/dumpsters/state-machine";

/** Tailwind classes for status badges (tint bg + deep ink text). */
export const STATUS_BADGE_CLASS: Record<DumpsterStatus, string> = {
  available: "bg-teal-tint text-teal-tint-ink",
  reserved: "bg-purple-tint text-purple-tint-ink",
  deployed: "bg-pink-tint text-pink-tint-ink",
  overdue: "bg-orange-tint text-orange-tint-ink",
  out_of_service: "bg-tint text-ink-2",
};

export const STATUS_HEX: Record<DumpsterStatus, string> = {
  available: BRAND_HEX.teal,
  reserved: BRAND_HEX.purple,
  deployed: BRAND_HEX.pink,
  overdue: BRAND_HEX.orange,
  out_of_service: BRAND_HEX["gray-st"],
};
