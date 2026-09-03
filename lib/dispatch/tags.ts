/**
 * Known job-tag vocabulary for the dispatcher tag editor. job_tags is an open
 * text[] in the DB (so new tags need no migration); this is just the UI's
 * suggested set. `roofing` and `heavy_construction` back real truck_restrictions.
 */
export const KNOWN_JOB_TAGS = [
  "roofing",
  "heavy_construction",
  "stone_concrete",
  "commercial",
  "residential",
  "hazmat_review",
] as const;

export type JobTag = (typeof KNOWN_JOB_TAGS)[number];

export function prettyTag(t: string): string {
  return t.replace(/_/g, " ");
}
