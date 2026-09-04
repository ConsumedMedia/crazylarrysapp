import { requireCustomer } from "@/lib/auth/requireCustomer";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "./_components/SignOutButton";

export const dynamic = "force-dynamic";

export default async function AccountPortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const customer = await requireCustomer();

  // Best-effort: link any guest booking made under this verified email.
  // Idempotent and safe to call on every load — see claim_guest_bookings().
  const supabase = createClient();
  await supabase.rpc("claim_guest_bookings").then(
    () => {},
    () => {},
  );

  return (
    <div className="min-h-screen bg-bg text-ink">
      <header className="flex items-center gap-3 border-b-2 border-line-strong bg-surface px-4 py-3 md:px-7">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 flex-none place-items-center bg-pink text-[13px] font-black text-white">
            CL
          </div>
          <div className="text-[11px] font-extrabold uppercase leading-tight tracking-[0.12em]">
            Crazy&nbsp;Larry&apos;s
            <br />
            <span className="text-[9px] tracking-[0.18em] text-ink-3">
              My account
            </span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-[12px] font-bold text-ink-2 sm:inline">
            {customer.fullName ?? customer.email}
          </span>
          <SignOutButton />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6 md:px-7">{children}</main>
    </div>
  );
}
