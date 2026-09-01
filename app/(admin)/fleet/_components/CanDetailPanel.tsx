import Link from "next/link";
import type { DumpsterDetail } from "@/lib/dumpsters/types";
import { STATUS_META, nextStatuses } from "@/lib/dumpsters/state-machine";
import { STATUS_HEX } from "@/lib/design/tokens";
import { CanActions } from "./CanActions";

export function CanDetailPanel({
  detail,
  closeHref,
}: {
  detail: DumpsterDetail;
  closeHref: string;
}) {
  const { unit, history } = detail;
  const meta = STATUS_META[unit.status];

  return (
    <section
      className="bg-surface"
      style={{ border: `2px solid ${STATUS_HEX[unit.status]}` }}
    >
      <div
        className="flex items-center justify-between px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.16em] text-white"
        style={{ background: STATUS_HEX[unit.status] }}
      >
        <span className="cl-nums">{unit.unit_number}</span>
        <span className="flex items-center gap-3">
          {unit.size.replace("yd", " yd")}
          <Link href={closeHref} scroll={false} className="text-white/80 hover:text-white">
            ✕
          </Link>
        </span>
      </div>

      <div className="flex flex-col gap-3 p-4">
        <div>
          <div className="mb-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
            Status
          </div>
          <div className="text-[15px] font-extrabold" style={{ color: STATUS_HEX[unit.status] }}>
            {meta.label}
            {unit.daysInStatus !== null && (
              <span className="text-ink-2">
                {" "}
                ·{" "}
                {unit.status === "available"
                  ? `${unit.daysInStatus}d in yard`
                  : `day ${unit.daysInStatus}`}
              </span>
            )}
          </div>
        </div>

        <CanActions
          id={unit.id}
          nextStatuses={nextStatuses(unit.status)}
          notes={unit.condition_notes}
        />

        <div className="border-t border-line pt-3">
          <div className="mb-2 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
            Recent history
          </div>
          <ul className="flex flex-col gap-1.5 text-[12px]">
            {history.length === 0 && (
              <li className="text-ink-2">No status changes recorded.</li>
            )}
            {history.slice(0, 6).map((h) => (
              <li key={h.id} className="flex items-baseline gap-2">
                <span className="cl-nums w-24 flex-none text-ink-3">
                  {new Date(h.changed_at).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
                <span>
                  {h.old_status ? `${h.old_status} → ` : "created · "}
                  <strong>{h.new_status}</strong>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
