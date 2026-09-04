import Link from "next/link";
import { SignupForm } from "./SignupForm";

export const metadata = { title: "Create account · Crazy Larry's" };

export default function AccountSignupPage() {
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
              Create your account
            </span>
          </div>
        </div>
        <div className="p-5">
          <p className="mb-4 text-[12px] text-ink-2">
            Booked with us before? Sign up with the same email and your past
            bookings show up automatically.
          </p>
          <SignupForm />
          <p className="mt-4 text-[12px] text-ink-2">
            Already have an account?{" "}
            <Link href="/account/login" className="font-extrabold text-pink hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
