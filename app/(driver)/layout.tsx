import { requireDriver } from "@/lib/auth/requireDriver";
import { signOutAction } from "@/lib/auth/actions";

export const dynamic = "force-dynamic";

export default async function DriverLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const driver = await requireDriver();

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col bg-bg text-ink">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b-2 border-line-strong bg-rail-bg px-4 py-3 text-white">
        <div className="grid h-8 w-8 flex-none place-items-center bg-pink text-[13px] font-black">
          CL
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-bold">{driver.fullName}</div>
          <div className="text-[9px] uppercase tracking-[0.16em] text-rail-ink-2">
            Driver
          </div>
        </div>
        <form action={signOutAction}>
          <button className="border border-white/20 px-2 py-1 text-[11px] font-extrabold text-rail-ink-2 hover:text-white">
            Sign out
          </button>
        </form>
      </header>
      {!driver.active && (
        <p className="border-b-2 border-orange bg-orange-tint px-4 py-2 text-[12px] font-semibold text-orange-tint-ink">
          Your driver account is inactive. Talk to the office.
        </p>
      )}
      <main className="flex-1 p-4 pb-24">{children}</main>
    </div>
  );
}
