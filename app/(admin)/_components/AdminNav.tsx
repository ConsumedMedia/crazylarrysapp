"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  key: string;
  label: string;
  href: string | null;
  badge?: string;
}

export function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <div className="flex flex-col gap-px py-3">
      {items.map((item) => {
        const active = item.href ? pathname.startsWith(item.href) : false;
        if (!item.href) {
          return (
            <span
              key={item.key}
              aria-disabled
              className="flex items-center gap-3 px-4 py-2.5 text-[13px] font-semibold text-rail-ink-2/60"
            >
              {item.label}
            </span>
          );
        }
        return (
          <Link
            key={item.key}
            href={item.href}
            data-active={active ? "1" : "0"}
            className={`flex items-center gap-3 px-4 py-2.5 text-[13px] font-semibold ${
              active
                ? "bg-pink/[0.18] text-white shadow-[inset_3px_0_0_#e91e8c]"
                : "text-rail-ink-2 hover:bg-white/[0.07] hover:text-white"
            }`}
          >
            {item.label}
            {item.badge && (
              <span className="ml-auto bg-orange px-1.5 py-0.5 text-[10px] font-extrabold text-[#14161a]">
                {item.badge}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

export function BottomNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t-2 border-line-strong bg-surface md:hidden">
      {items.map((item) => {
        const active = item.href ? pathname.startsWith(item.href) : false;
        const cls =
          "flex flex-1 flex-col items-center gap-1 py-2 text-[10px] font-bold uppercase tracking-wide";
        return item.href ? (
          <Link
            key={item.key}
            href={item.href}
            className={`${cls} ${active ? "text-pink" : "text-ink-2"}`}
          >
            {item.label}
          </Link>
        ) : (
          <span
            key={item.key}
            aria-disabled
            className={`${cls} text-ink-3`}
          >
            {item.label}
          </span>
        );
      })}
    </nav>
  );
}
