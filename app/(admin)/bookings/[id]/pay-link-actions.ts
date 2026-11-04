"use server";

import { revalidatePath } from "next/cache";
import { NotAuthorizedError } from "@/lib/auth/requireStaff";
import { resendPayLink, PayLinkError } from "@/lib/pay-links/staff";
import { scrubPayTokens } from "@/lib/pay-links/contact";
import type { ChannelOutcome } from "@/lib/notifications/notify";

export interface ResendState {
  ok: boolean;
  error?: string;
  sent?: ChannelOutcome[];
  /** Set only when nothing went out. Shown once; never logged or put in a URL. */
  url?: string | null;
}

/** Send / Resend: a new link replaces the old one (dead in the same transaction). */
export async function resendPayLinkAction(_prev: ResendState, formData: FormData): Promise<ResendState> {
  const id = String(formData.get("id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: "Unknown booking." };
  try {
    const r = await resendPayLink(id);
    revalidatePath(`/bookings/${id}`);
    return { ok: true, sent: r.sent, url: r.url };
  } catch (e) {
    if (e instanceof NotAuthorizedError || e instanceof PayLinkError) {
      return { ok: false, error: scrubPayTokens(e.message) };
    }
    console.error("[pay-link resend] failed:", scrubPayTokens(e instanceof Error ? e.message : String(e)));
    return { ok: false, error: "Something went wrong. Reload the booking to see whether a new link went out." };
  }
}
