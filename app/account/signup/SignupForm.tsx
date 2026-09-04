"use client";

import { useFormState, useFormStatus } from "react-dom";
import { signUpCustomerAction, type CustomerAuthState } from "@/lib/auth/customerActions";

const initial: CustomerAuthState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full bg-teal px-4 py-3 text-left text-[13px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-60"
    >
      {pending ? "Creating account…" : "Create account"}
    </button>
  );
}

export function SignupForm() {
  const [state, formAction] = useFormState(signUpCustomerAction, initial);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
        Full name
        <input
          type="text"
          name="fullName"
          autoComplete="name"
          required
          className="border-2 border-line bg-bg px-3 py-2 text-[13px] font-medium normal-case tracking-normal text-ink"
        />
      </label>
      <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
        Email
        <input
          type="email"
          name="email"
          autoComplete="username"
          required
          className="border-2 border-line bg-bg px-3 py-2 text-[13px] font-medium normal-case tracking-normal text-ink"
        />
      </label>
      <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
        Password
        <input
          type="password"
          name="password"
          autoComplete="new-password"
          required
          minLength={8}
          className="border-2 border-line bg-bg px-3 py-2 text-[13px] font-medium normal-case tracking-normal text-ink"
        />
      </label>
      {state.error && (
        <p className="text-[12px] font-semibold text-orange-tint-ink">
          {state.error}
        </p>
      )}
      {state.message && (
        <p className="text-[12px] font-semibold text-teal-tint-ink">
          {state.message}
        </p>
      )}
      <SubmitButton />
    </form>
  );
}
