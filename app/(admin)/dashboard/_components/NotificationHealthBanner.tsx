import type { ChannelHealth } from "@/lib/notifications/health";

const CATEGORY_HINT: Record<string, string> = {
  account_blocked: "the provider account needs attention (e.g. Quo A2P registration, Resend domain verification)",
  not_configured: "required environment variables aren't set",
};

const CHANNEL_LABEL: Record<string, string> = { email: "Email", sms: "SMS" };

/**
 * Silent when everything's fine or there's simply no recent send to judge.
 * Loud (orange) only for channels notification_health() marked 'blocked' —
 * an account/config problem, not a one-off bounce. 'degraded' gets a quiet
 * note since it's usually just a bad phone number or a transient blip.
 */
export function NotificationHealthBanner({ health }: { health: ChannelHealth[] }) {
  const blocked = health.filter((h) => h.status === "blocked");
  const degraded = health.filter((h) => h.status === "degraded");

  if (blocked.length === 0 && degraded.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {blocked.map((h) => (
        <div
          key={h.channel}
          className="border-l-4 border-orange bg-orange-tint px-3 py-2.5 text-[13px] text-orange-tint-ink"
        >
          <strong>{CHANNEL_LABEL[h.channel]} notifications aren&apos;t going out.</strong>{" "}
          {h.lastCategory && CATEGORY_HINT[h.lastCategory]
            ? `Looks like ${CATEGORY_HINT[h.lastCategory]}.`
            : null}{" "}
          Last error: {h.lastError ?? "unknown"}
        </div>
      ))}
      {degraded.map((h) => (
        <div
          key={h.channel}
          className="border-l-4 border-line-strong bg-surface-2 px-3 py-2 text-[12px] text-ink-2"
        >
          {CHANNEL_LABEL[h.channel]}: {h.failed24h} of {h.sent24h + h.failed24h} attempts failed
          in the last 24h ({h.lastError ?? "see notifications_log"}) — worth a glance, not
          necessarily a systemic problem.
        </div>
      ))}
    </div>
  );
}
