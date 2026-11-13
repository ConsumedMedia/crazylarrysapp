import { NextResponse, type NextRequest } from "next/server";
import { readQuoSmsWebhookConfig } from "@/lib/sms-inbound/config";
import { handleQuoSmsWebhook, type RecordResult } from "@/lib/sms-inbound/quo-sms-webhook";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Quo SMS webhook (Plan B.4): inbound texts on the yard line, for STOP
 * handling. Public endpoint, so lib/sms-inbound/quo-sms-webhook.ts verifies the
 * signature before anything else, and the only database access is the
 * service-role-only record_sms_inbound RPC, called only for keyword texts.
 *
 * Off unless CL_QUO_SMS_WEBHOOK_ENABLED=1, and then refuses everything until
 * both QUO_SMS_WEBHOOK_KEY (whsec_...) and QUO_ORG_ID are set. Separate from
 * /api/webhooks/quo (the call log), which keeps its own flag and key.
 *
 *   POST /api/webhooks/quo-sms   webhook-id / webhook-timestamp / webhook-signature
 */
export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get("content-length"));
  const result = await handleQuoSmsWebhook(
    {
      // Raw text, never request.json(): the signature covers the exact bytes.
      rawBody: await request.text(),
      contentLength: Number.isFinite(contentLength) ? contentLength : null,
      headers: {
        webhookId: request.headers.get("webhook-id"),
        webhookTimestamp: request.headers.get("webhook-timestamp"),
        webhookSignature: request.headers.get("webhook-signature"),
      },
    },
    {
      config: readQuoSmsWebhookConfig(),
      nowSeconds: Math.floor(Date.now() / 1000),
      record: async (a) => {
        const { data, error } = await createServiceClient().rpc("record_sms_inbound", {
          p_message_id: a.messageId,
          p_webhook_id: a.webhookId,
          p_sender: a.sender,
          p_kind: a.kind,
          p_keyword: a.keyword,
          p_received_at: a.receivedAt,
          p_review_text: a.reviewText,
        });
        if (error) throw new Error(error.code ?? "record_failed");
        const r = data as RecordResult | null;
        if (!r || (r.status !== "recorded" && r.status !== "duplicate")) throw new Error("record_bad_result");
        return r;
      },
    },
  );

  const { outcome, ...ids } = result.log;
  const line = `quo-sms-webhook ${outcome} ${JSON.stringify(ids)}`;
  if (result.status >= 500 && outcome !== "disabled") console.error(line);
  else console.log(line);

  return NextResponse.json(result.body, { status: result.status });
}
