import Link from "next/link";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in · Crazy Larry's" };

export default function AccountLoginPage({
  searchParams,
}: {
  searchParams: { denied?: string };
}) {
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-4 text-ink">
      <div className="w-full max-w-sm border-2 border-line-strong bg-surface">
        <div className="flex items-center gap-2.5 border-b-2 border-line-strong px-5 py-4">
          <div className="grid h-8 w-8 place-items-center bg-pink text-[13px] font-black text-white">
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
        <div className="p-5">
          {searchParams.denied && (
            <p className="mb-4 border-2 border-orange bg-orange-tint px-3 py-2 text-[12px] font-semibold text-orange-tint-ink">
              That account isn&apos;t set up for customer login.
            </p>
          )}
          <LoginForm />
          <p className="mt-4 text-[12px] text-ink-2">
            New here?{" "}
            <Link href="/account/signup" className="font-extrabold text-pink hover:underline">
              Create an account
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
