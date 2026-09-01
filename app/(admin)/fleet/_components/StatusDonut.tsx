import {
  DUMPSTER_STATUSES,
  STATUS_META,
  type DumpsterStatus,
} from "@/lib/dumpsters/state-machine";
import { STATUS_HEX } from "@/lib/design/tokens";

export function StatusDonut({
  total,
  byStatus,
}: {
  total: number;
  byStatus: Record<DumpsterStatus, number>;
}) {
  let cursor = 0;
  const stops: string[] = [];
  const legend: Array<{
    status: DumpsterStatus;
    n: number;
    pct: number;
  }> = [];

  for (const status of DUMPSTER_STATUSES) {
    const n = byStatus[status] ?? 0;
    const pct = total > 0 ? (n / total) * 100 : 0;
    const start = cursor;
    const end = cursor + pct;
    if (n > 0) {
      stops.push(`${STATUS_HEX[status]} ${start.toFixed(2)}% ${end.toFixed(2)}%`);
    }
    legend.push({ status, n, pct });
    cursor = end;
  }

  const gradient =
    stops.length > 0
      ? `conic-gradient(${stops.join(", ")})`
      : "var(--cl-tint)";

  return (
    <section className="border-2 border-line-strong bg-surface">
      <h2 className="border-b-2 border-line-strong px-4 py-3 text-[15px] font-extrabold">
        Status breakdown
      </h2>
      <div className="flex flex-col items-center gap-4 px-4 py-5">
        <div
          className="relative h-[150px] w-[150px] rounded-full"
          style={{ background: gradient }}
          role="img"
          aria-label={`${total} cans by status`}
        >
          <div className="absolute inset-[27px] grid place-items-center rounded-full bg-surface text-center">
            <div>
              <div className="cl-nums text-[30px] font-black leading-none tracking-[-0.04em]">
                {total}
              </div>
              <div className="text-[9px] font-extrabold uppercase tracking-[0.16em] text-ink-3">
                Cans
              </div>
            </div>
          </div>
        </div>
        <ul className="flex w-full flex-col gap-[7px]">
          {legend.map(({ status, n, pct }) => (
            <li key={status} className="flex items-center gap-2.5 text-[12px]">
              <span
                className="h-2.5 w-2.5 flex-none"
                style={{ background: STATUS_HEX[status] }}
              />
              <span className="flex-1">{STATUS_META[status].label}</span>
              <span className="cl-nums font-extrabold">{n}</span>
              <span className="cl-nums w-10 text-right text-ink-2">
                {pct.toFixed(0)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
