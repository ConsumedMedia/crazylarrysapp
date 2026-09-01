import Link from "next/link";
import type { FleetUnit } from "@/lib/dumpsters/types";
import { STATUS_META } from "@/lib/dumpsters/state-machine";
import { STATUS_HEX } from "@/lib/design/tokens";

export function CanTile({
  unit,
  href,
  active,
}: {
  unit: FleetUnit;
  href: string;
  active: boolean;
}) {
  const meta = STATUS_META[unit.status];
  const dayLabel =
    unit.daysInStatus === null
      ? ""
      : unit.status === "available"
        ? `${unit.daysInStatus}d in yard`
        : `day ${unit.daysInStatus}`;

  return (
    <Link
      href={href}
      scroll={false}
      data-active={active ? "1" : "0"}
      className={`flex min-h-[96px] flex-col gap-1.5 bg-surface p-2.5 outline-offset-[-3px] hover:outline hover:outline-[3px] hover:outline-ink data-[active=1]:outline data-[active=1]:outline-[3px] data-[active=1]:outline-ink`}
      style={{ borderTop: `5px solid ${STATUS_HEX[unit.status]}` }}
    >
      <div className="flex items-baseline justify-between gap-1">
        <span className="cl-nums whitespace-nowrap text-[13px] font-black tracking-[-0.01em]">
          {unit.unit_number}
        </span>
        <span className="text-[10px] font-extrabold text-ink-3">
          {unit.size.replace("yd", " yd")}
        </span>
      </div>
      <div
        className="text-[10px] font-extrabold uppercase leading-tight tracking-[0.07em]"
        style={{ color: STATUS_HEX[unit.status] }}
      >
        {meta.label}
      </div>
      {unit.condition_notes && (
        <div className="mt-auto line-clamp-2 text-[10px] leading-snug text-ink-2">
          {unit.condition_notes}
        </div>
      )}
      <div
        className={`cl-nums text-[10px] font-bold text-ink-2 ${
          unit.condition_notes ? "" : "mt-auto"
        }`}
      >
        {dayLabel}
      </div>
    </Link>
  );
}
