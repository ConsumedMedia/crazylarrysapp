"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { completeInviteAction } from "@/lib/auth/actions";

type Stage = "checking" | "invalid" | "ready" | "done-error";

const inputCls =
  "border-2 border-line bg-bg px-3 py-2 text-[13px] font-medium normal-case tracking-normal text-ink";
const labelCls =
  "flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3";

export function AcceptInviteForm() {
  const [stage, setStage] = useState<Stage>("checking");
  const [linkType, setLinkType] = useState<"invite" | "recovery" | "other">("invite");
  const [tokens, setTokens] = useState<{ access: string; refresh: string } | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const processedRef = useRef(false);

  useEffect(() => {
    // React Strict Mode double-invokes effects in dev. This effect both
    // reads AND mutates window.location (replaceState strips the tokens),
    // so a second invocation would read the already-stripped URL and
    // clobber the correct "ready" state with "invalid". Guard so the
    // token-parsing logic only actually runs once.
    if (processedRef.current) return;
    processedRef.current = true;

    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(hash);
    const access_token = params.get("access_token");
    const refresh_token = params.get("refresh_token");
    const type = params.get("type");

    // Strip the tokens out of the URL bar/history right away, regardless of
    // whether they turn out to be valid.
    window.history.replaceState(null, "", window.location.pathname);

    if (!access_token || !refresh_token) {
      setStage("invalid");
      return;
    }

    setLinkType(type === "recovery" ? "recovery" : type === "invite" ? "invite" : "other");
    setTokens({ access: access_token, refresh: refresh_token });
    setStage("ready");
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!tokens) return;
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }

    startTransition(async () => {
      const result = await completeInviteAction(tokens.access, tokens.refresh, password);
      // Only reached if completeInviteAction did NOT redirect.
      if (result?.error) {
        setError(result.error);
        setStage("done-error");
      }
    });
  }

  if (stage === "checking") {
    return <p className="text-[13px] text-ink-2">Checking your link…</p>;
  }

  if (stage === "invalid") {
    return (
      <p className="text-[13px] text-ink-2">
        This link is invalid or has expired. Ask an admin to send you a new
        invite, or contact them to reset your password.
      </p>
    );
  }

  if (stage === "done-error") {
    return <p className="text-[13px] font-semibold text-orange-tint-ink">{error}</p>;
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className="text-[13px] text-ink-2">
        {linkType === "recovery"
          ? "Choose a new password for your account."
          : "Welcome to Crazy Larry's — choose a password to finish setting up your account."}
      </p>
      <label className={labelCls}>
        New password
        <input
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputCls}
        />
      </label>
      <label className={labelCls}>
        Confirm password
        <input
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={inputCls}
        />
      </label>
      {error && (
        <p className="text-[12px] font-semibold text-orange-tint-ink">{error}</p>
      )}
      <button
        type="submit"
        disabled={isPending}
        className="w-full bg-teal px-4 py-3 text-left text-[13px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-60"
      >
        {isPending ? "Saving…" : "Set password & continue"}
      </button>
    </form>
  );
}
