"use client";

import { usePathname } from "next/navigation";

/**
 * Subtle fade on route change — the whole "page transition" story. Keyed on
 * pathname so React remounts this div on navigation, which replays the CSS
 * animation (a plain transition can't do that on its own, since nothing's
 * "changing" from React's point of view otherwise).
 *
 * Deliberately just opacity, no slide/scale — nothing that reads as a
 * loading delay. prefers-reduced-motion kills the animation globally (see
 * globals.css), so this degrades to an instant, un-animated swap for anyone
 * who's asked for that.
 */
export function RouteFade({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="cl-fade-in">
      {children}
    </div>
  );
}
