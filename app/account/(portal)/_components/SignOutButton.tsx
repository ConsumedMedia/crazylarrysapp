"use client";

import { signOutCustomerAction } from "@/lib/auth/customerActions";

export function SignOutButton() {
  return (
    <form action={signOutCustomerAction}>
      <button
        type="submit"
        className="border-2 border-line px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.08em] hover:border-ink"
      >
        Sign out
      </button>
    </form>
  );
}
