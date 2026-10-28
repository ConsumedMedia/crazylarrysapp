import { NextResponse, type NextRequest } from "next/server";
import { readQuoWebhookConfig } from "@/lib/call-log/config";
import { handleQuoWebhook } from "@/lib/call-log/quo-webhook";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Quo call webhook — public endpoint, so lib/call-log/quo-webhook.ts verifies
 * the signature before anything else and the only DB access is the
 * service-role-only ingest_quo_call_event RPC.
 *
 * Off unless CL_QUO_WEBHOOK_ENABLED=1, and then refuses everything until both
 * QUO_WEBHOOK_KEY (whsec_...) and QUO_ORG_ID are set.
 *
 *   POST /api/webhooks/quo   webhook-id / webhook-timestamp / webhook-signature
 */
export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get("content-length"));
  const result = await handleQuoWebhook(
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
      config: readQuoWebhookConfig(),
      nowSeconds: Math.floor(Date.now() / 1000),
      ingest: async (callId, webhookId, fields) => {
        const { error } = await createServiceClient().rpc("ingest_quo_call_event", {
          p_call_id: callId,
          p_webhook_id: webhookId,
          p_event: fields,
        });
        if (error) throw new Error(error.code ?? "ingest_failed");
      },
    },
  );

  const { outcome, ...ids } = result.log;
  const line = `quo-webhook ${outcome} ${JSON.stringify(ids)}`;
  if (result.status >= 500 && outcome !== "disabled") console.error(line);
  else console.log(line);

  return NextResponse.json(result.body, { status: result.status });
}
