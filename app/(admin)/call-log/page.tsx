import Link from "next/link";
import { requireStaff } from "@/lib/auth/requireStaff";
import { listCallTranscripts, type CallTranscriptRow } from "@/lib/call-log/queries";
import { callLabel, isMissedCall, summaryLines } from "@/lib/call-log/display";
import { prettyPhone } from "@/lib/notifications/phone";
import { BRAND_BADGE_CLASS } from "@/lib/design/tokens";

export const dynamic = "force-dynamic";
export const metadata = { title: "Call log · Crazy Larry's" };

function fmtDuration(sec: number | null) {
  if (sec === null) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtTs(d: string) {
  return new Date(d).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtOffset(sec: number | null) {
  if (sec === null) return "";
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function Caller({ c }: { c: CallTranscriptRow }) {
  const number = c.caller_number ? prettyPhone(c.caller_number) : null;
  if (c.customer_id) {
    return (
      <span className="flex-1 truncate">
        <Link href={`/customers/${c.customer_id}`} className="font-extrabold underline-offset-2 hover:underline">
          {c.customer_name ?? "Customer"}
        </Link>
        {number && <span className="cl-nums text-ink-2"> · {number}</span>}
      </span>
    );
  }
  return (
    <span className="flex-1 truncate">
      <span className="cl-nums font-extrabold">{number ?? "Unknown caller"}</span>
      {c.matched_customers.length > 0 && (
        <span className="text-ink-2">
          {" "}
          · {c.matched_customers.length} customers share this number:{" "}
          {c.matched_customers.map((m, i) => (
            <span key={m.id}>
              {i > 0 && ", "}
              <Link href={`/customers/${m.id}`} className="underline-offset-2 hover:underline">
                {m.full_name}
              </Link>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

export default async function CallLogPage() {
  await requireStaff();
  const calls = await listCallTranscripts();
  const missed = calls.filter((c) => isMissedCall(c.direction, c.call_status)).length;

  return (
    <div className="flex flex-col gap-4 p-4 md:p-7">
      <div>
        <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
          Call log
        </h1>
        <p className="text-[12px] text-ink-2">
          Calls on the yard&apos;s Quo line. {calls.length} on file
          {missed > 0 && <>, {missed} missed</>}.
        </p>
      </div>

      <section className="border-2 border-line-strong bg-surface">
        {calls.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center">
            <p className="text-[14px] font-bold text-ink">No calls logged yet.</p>
            <p className="max-w-md text-[12px] text-ink-2">
              Calls appear here automatically once Quo&apos;s webhook is switched on for
              this line. Summaries and transcripts follow a few seconds after each
              recorded call.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col">
            {calls.map((c) => {
              const isMissed = isMissedCall(c.direction, c.call_status);
              const lines = summaryLines(c.summary);
              const hasTranscript = c.transcript_dialogue.length > 0 || !!c.transcript;
              return (
                <li
                  key={c.id}
                  className={`border-b border-line px-4 py-3 text-[13px] last:border-b-0 ${
                    isMissed ? "border-l-4 border-l-orange bg-orange-tint" : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="cl-nums w-32 flex-none font-extrabold">
                      {fmtTs(c.call_started_at ?? c.received_at)}
                    </span>
                    <span
                      className={`px-2 py-0.5 text-[10px] font-extrabold uppercase ${
                        BRAND_BADGE_CLASS[isMissed ? "orange" : c.direction === "outgoing" ? "purple" : "teal"]
                      }`}
                    >
                      {callLabel(c.direction, c.call_status, c.has_voicemail)}
                    </span>
                    <Caller c={c} />
                    <span className="cl-nums text-ink-2">{fmtDuration(c.duration_seconds)}</span>
                  </div>

                  {lines.length > 0 && (
                    <ul className="mt-1.5 list-disc pl-5 text-ink-2">
                      {lines.map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  )}

                  {c.next_steps.length > 0 && (
                    <div className="mt-1.5">
                      <span className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
                        Next steps
                      </span>
                      <ul className="list-disc pl-5 text-ink-2">
                        {c.next_steps.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {c.voicemail_transcript && (
                    <p className="mt-1.5 text-ink-2">
                      <span className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
                        Voicemail{" "}
                      </span>
                      {c.voicemail_transcript}
                    </p>
                  )}

                  {hasTranscript && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[12px] font-extrabold text-ink-2 hover:text-ink">
                        Transcript
                      </summary>
                      {c.transcript_dialogue.length > 0 ? (
                        <ol className="mt-2 flex flex-col gap-1 border-l-2 border-line pl-3">
                          {c.transcript_dialogue.map((d, i) => (
                            <li key={i} className="flex gap-2">
                              <span className="cl-nums w-10 flex-none text-ink-3">{fmtOffset(d.start)}</span>
                              <span
                                className={`w-14 flex-none text-[11px] font-extrabold uppercase ${
                                  d.speaker === "staff" ? "text-teal-tint-ink" : "text-ink-2"
                                }`}
                              >
                                {d.speaker === "staff" ? "Staff" : "Caller"}
                              </span>
                              <span className="min-w-0 break-words">{d.content}</span>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className="mt-2 whitespace-pre-wrap text-ink-2">{c.transcript}</p>
                      )}
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
