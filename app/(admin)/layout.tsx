import Link from "next/link";
import { requireStaff } from "@/lib/auth/requireStaff";
import { SignOutButton } from "./_components/SignOutButton";

export const dynamic = "force-dynamic";

const NAV = [
  { key: "overview", label: "Overview", href: null },
  { key: "fleet", label: "Fleet", href: "/fleet" },
  { key: "schedule", label: "Schedule", href: null },
  { key: "bookings", label: "Bookings", href: null },
  { key: "drivers", label: "Drivers", href: null },
  { key: "customers", label: "Customers", href: null },
  { key: "call-log", label: "Call log", href: null },
] as const;

function initials(name: string | null, email: string | null) {
  const src = name ?? email ?? "?";
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?").concat(parts[1]?.[0] ?? "").toUpperCase();
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const staff = await requireStaff();

  return (
    <div className="flex min-h-screen bg-bg text-ink">
      {/* Desktop sidebar */}
      <nav className="hidden md:flex w-[236px] flex-none flex-col bg-rail-bg border-r-2 border-line-strong">
        <div className="flex items-center gap-2.5 px-4 py-4 border-b border-white/10">
          <div className="grid h-8 w-8 flex-none place-items-center bg-pink text-[13px] font-black text-white">
            CL
          </div>
          <div className="text-[11px] font-extrabold uppercase leading-tight tracking-[0.12em] text-rail-ink">
            Crazy&nbsp;Larry&apos;s
            <br />
            <span className="text-[9px] tracking-[0.18em] text-rail-ink-2">
              Operations
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-px py-3">
          {NAV.map((item) =>
            item.href ? (
              <Link
                key={item.key}
                href={item.href}
                data-active="1"
                className="flex items-center gap-3 px-4 py-2.5 text-[13px] font-semibold text-white bg-pink/[0.18] shadow-[inset_3px_0_0_#e91e8c]"
              >
                {item.label}
                {item.key === "fleet" && (
                  <span className="ml-auto bg-orange px-1.5 py-0.5 text-[10px] font-extrabold text-[#14161a]">
                    3
                  </span>
                )}
              </Link>
            ) : (
              <span
                key={item.key}
                aria-disabled
                className="flex items-center gap-3 px-4 py-2.5 text-[13px] font-semibold text-rail-ink-2/60 cursor-not-allowed"
              >
                {item.label}
              </span>
            ),
          )}
        </div>
        <div className="mt-auto flex items-center gap-2.5 border-t border-white/10 p-4">
          <div className="grid h-8 w-8 flex-none place-items-center bg-pink text-[11px] font-extrabold text-white">
            {initials(staff.fullName, staff.email)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-bold text-rail-ink">
              {staff.fullName ?? staff.email}
            </div>
            <div className="text-[9px] uppercase tracking-[0.14em] text-rail-ink-2">
              {staff.role}
            </div>
          </div>
          <SignOutButton />
        </div>
      </nav>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b-2 border-line-strong bg-surface px-4 py-3 md:px-7">
          <div className="flex flex-1 items-center gap-2.5 border-2 border-line bg-bg px-3 py-2">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--cl-ink-3)"
              strokeWidth="2.2"
              strokeLinecap="round"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <span className="truncate text-[12px] text-ink-3">
              Search a can number, address, or customer
            </span>
          </div>
          <div className="hidden items-center gap-2 md:flex">
            <div className="flex items-center gap-2 border-2 border-line py-[3px] pl-[3px] pr-2.5">
              <div className="grid h-7 w-7 place-items-center bg-teal text-[11px] font-extrabold text-white">
                {initials(staff.fullName, staff.email)}
              </div>
              <div className="text-[12px] font-bold">
                {(staff.fullName ?? staff.email ?? "").split(" ")[0]}
              </div>
            </div>
          </div>
        </header>

        <main className="flex-1 pb-24 md:pb-0">{children}</main>
      </div>

      {/* Mobile bottom bar */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t-2 border-line-strong bg-surface md:hidden">
        {NAV.slice(0, 5).map((item) =>
          item.href ? (
            <Link
              key={item.key}
              href={item.href}
              className="flex flex-1 flex-col items-center gap-1 py-2 text-[10px] font-bold uppercase tracking-wide text-pink"
            >
              {item.label}
            </Link>
          ) : (
            <span
              key={item.key}
              aria-disabled
              className="flex flex-1 flex-col items-center gap-1 py-2 text-[10px] font-bold uppercase tracking-wide text-ink-3"
            >
              {item.label}
            </span>
          ),
        )}
      </nav>
    </div>
  );
}
