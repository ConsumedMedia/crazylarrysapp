import "server-only";
import { createClient } from "@/lib/supabase/server";

export interface ChannelHealth {
  channel: "email" | "sms";
  status: "ok" | "blocked" | "degraded" | "no_data";
  sent24h: number;
  failed24h: number;
  skipped24h: number;
  lastAttemptAt: string | null;
  lastCategory: string | null;
  lastError: string | null;
}

/** notification_health() via the caller's own staff session — never throws. */
export async function getNotificationHealth(): Promise<ChannelHealth[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("notification_health");
    if (error || !Array.isArray(data)) return [];
    return data.map((r: Record<string, unknown>) => ({
      channel: r.channel as "email" | "sms",
      status: r.status as ChannelHealth["status"],
      sent24h: Number(r.sent_24h ?? 0),
      failed24h: Number(r.failed_24h ?? 0),
      skipped24h: Number(r.skipped_24h ?? 0),
      lastAttemptAt: (r.last_attempt_at as string | null) ?? null,
      lastCategory: (r.last_category as string | null) ?? null,
      lastError: (r.last_error as string | null) ?? null,
    }));
  } catch {
    return [];
  }
}
