import { requireStaff } from "@/lib/auth/requireStaff";
import { listCallTranscripts } from "@/lib/call-log/queries";

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

export default async function CallLogPage() {
  await requireStaff();
  const calls = await listCallTranscripts();

  return (
    <div className="flex flex-col gap-4 p-4 md:p-7">
      <div>
        <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
          Call log
        </h1>
        <p className="text-[12px] text-ink-2">
          Quo call transcripts. {calls.length} on file.
        </p>
      </div>

      <section className="border-2 border-line-strong bg-surface">
        {calls.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center">
            <p className="text-[14px] font-bold text-ink">No calls logged yet.</p>
            <p className="max-w-md text-[12px] text-ink-2">
              This table is populated by Quo&apos;s call-transcript webhook, which
              hasn&apos;t been wired up yet — that&apos;s a separate integration,
              not part of this screen. Once it&apos;s connected, transcripts will
              appear here automatically.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col">
            {calls.map((c) => (
              <li key={c.id} className="border-b border-line px-4 py-3 text-[13px] last:border-b-0">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="cl-nums w-32 flex-none font-extrabold">
                    {fmtTs(c.received_at)}
                  </span>
                  <span className="flex-1 truncate">
                    {c.customer_name ?? c.caller_number ?? "Unknown caller"}
                  </span>
                  <span className="cl-nums text-ink-2">{fmtDuration(c.duration_seconds)}</span>
                </div>
                {c.summary && <p className="mt-1.5 text-ink-2">{c.summary}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
