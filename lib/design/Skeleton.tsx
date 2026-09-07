/**
 * A single skeleton block — just `.cl-skeleton` (see globals.css) with a
 * size. No hooks, so it's safe to use from Server Components (loading.tsx
 * files) as well as client ones (the availability calendars).
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`cl-skeleton ${className}`} />;
}
