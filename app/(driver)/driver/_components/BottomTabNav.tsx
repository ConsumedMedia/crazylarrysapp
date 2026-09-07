"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  {
    key: "jobs",
    label: "Jobs",
    href: "/driver",
    icon: "M4 5h16M4 12h16M4 19h16",
  },
  {
    key: "map",
    label: "Map",
    href: "/driver/map",
    icon: "M1 6l7-3 8 3 7-3v15l-7 3-8-3-7 3z M8 3v15 M16 6v15",
  },
  {
    key: "done",
    label: "Done",
    href: "/driver/done",
    icon: "m4 12.5 5 5L20 6.5",
  },
  {
    key: "me",
    label: "Me",
    href: "/driver/me",
    icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M4 21c0-4 3.6-7 8-7s8 3 8 7",
  },
];

export function BottomTabNav() {
  const pathname = usePathname();

  return (
    <nav className="sticky bottom-0 z-10 flex border-t-2 border-line-strong bg-rail-bg">
      {TABS.map((t) => {
        const active =
          t.href === "/driver" ? pathname === "/driver" : pathname.startsWith(t.href);
        return (
          <Link
            key={t.key}
            href={t.href}
            className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-extrabold tracking-[0.02em] ${
              active ? "text-pink" : "text-rail-ink-2"
            }`}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={active ? 2.4 : 2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={t.icon} />
            </svg>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
