"use client";

import type { ChannelOutcome } from "@/lib/notifications/notify";
import type { FailureCategory } from "@/lib/notifications/sms";

const CHANNEL = { email: "Email", sms: "Text" } as const;

const WHY: Record<FailureCategory, string> = {
  no_consent: "the customer hasn't agreed to texts",
  recipient_missing: "no address or number on file, or a reserved test contact",
  test_mode: "skipped in test mode",
  disabled: "notifications are turned off on this server",
  not_configured: "this channel isn't set up on this server",
  account_blocked: "the provider account is blocked",
  provider_rejected: "the provider rejected it",
  rate_limited: "the provider is rate-limiting — try Resend later",
  transient: "the provider had a temporary problem",
};

export function outcomeLine(o: ChannelOutcome): string {
  const what = CHANNEL[o.channel];
  if (o.status === "sent") return `${what} sent${o.redirected ? " — to the test address (CL_NOTIFICATIONS_TEST_TO)" : ""}`;
  const why = o.category ? WHY[o.category as FailureCategory] ?? o.category.replace(/_/g, " ") : null;
  return `${what} ${o.status === "skipped" ? "not sent" : "failed"}${why ? `: ${why}` : ""}`;
}

/**
 * What went out after a link was issued. `url` is present only when nothing
 * was sent: it is shown once, with Copy, and lives nowhere else.
 */
export function PayLinkResult({
  title,
  sent,
  url,
}: {
  title: string;
  sent: ChannelOutcome[];
  url: string | null | undefined;
}) {
  const anySent = sent.some((o) => o.status === "sent");
  return (
    <div className="flex flex-col gap-2 border-2 border-line-strong bg-surface p-3" data-testid="pay-link-result">
      <p className={`text-[13px] font-extrabold ${anySent ? "text-teal-tint-ink" : "text-orange-tint-ink"}`}>{title}</p>
      <ul className="flex flex-col gap-0.5 text-[12px]">
        {sent.length === 0 && <li>Nothing was sent.</li>}
        {sent.map((o) => (
          <li key={o.channel}>{outcomeLine(o)}</li>
        ))}
      </ul>
      {url && (
        <div className="flex flex-col gap-1.5 border-t-2 border-line pt-2">
          <p className="text-[12px] font-semibold">
            Nothing reached the customer. Give them this link yourself — it is shown only now. Leaving this
            page loses it; Resend on the booking makes a new one.
          </p>
          <div className="flex gap-2">
            <input
              readOnly
              value={url}
              aria-label="Pay link"
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 border-2 border-line bg-bg px-2.5 py-2 text-[12px] text-ink"
            />
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(url)}
              className="border-2 border-ink px-3 py-2 text-[12px] font-extrabold hover:bg-tint"
            >
              Copy
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
