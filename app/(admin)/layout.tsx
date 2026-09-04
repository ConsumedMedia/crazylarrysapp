import { requireStaff } from "@/lib/auth/requireStaff";
import { SignOutButton } from "./_components/SignOutButton";
import { SidebarNav, BottomNav, type NavItem } from "./_components/AdminNav";

export const dynamic = "force-dynamic";

const NAV: NavItem[] = [
  { key: "overview", label: "Overview", href: "/dashboard" },
  { key: "fleet", label: "Fleet", href: "/fleet" },
  { key: "schedule", label: "Schedule", href: "/schedule" },
  { key: "dispatch", label: "Dispatch", href: "/dispatch" },
  { key: "bookings", label: "Bookings", href: "/bookings" },
  { key: "drivers", label: "Drivers", href: "/drivers" },
  { key: "customers", label: "Customers", href: "/customers" },
  { key: "call-log", label: "Call log", href: "/call-log" },
  { key: "settings", label: "Settings", href: "/settings" },
];

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
      <nav className="hidden w-[236px] flex-none flex-col border-r-2 border-line-strong bg-rail-bg md:flex">
        <div className="flex items-center gap-2.5 border-b border-white/10 px-4 py-4">
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

        <SidebarNav items={NAV} />

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

      <BottomNav items={NAV.slice(0, 5)} />
    </div>
  );
}
