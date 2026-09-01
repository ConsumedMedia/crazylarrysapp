"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  DUMPSTER_STATUSES,
  STATUS_META,
  type DumpsterStatus,
} from "@/lib/dumpsters/state-machine";
import { STATUS_HEX } from "@/lib/design/tokens";
import type { FleetSummary } from "@/lib/dumpsters/types";

export function FilterBar({
  total,
  byStatus,
  bySize,
  activeStatus,
  activeSize,
}: {
  total: number;
  byStatus: Record<DumpsterStatus, number>;
  bySize: FleetSummary["bySize"];
  activeStatus: DumpsterStatus | null;
  activeSize: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function setParam(key: "status" | "size", value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (value === null || next.get(key) === value) next.delete(key);
    else next.set(key, value);
    next.delete("sel"); // clear selection when the filter changes
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  const chipBase =
    "flex items-center gap-1.5 border-2 px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-[0.06em] cursor-pointer";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        onClick={() => setParam("status", null)}
        className={`${chipBase} ${
          activeStatus === null
            ? "border-ink bg-ink text-surface"
            : "border-line text-ink hover:border-ink"
        }`}
      >
        All {total}
      </button>

      {DUMPSTER_STATUSES.map((s) => (
        <button
          key={s}
          onClick={() => setParam("status", s)}
          className={`${chipBase} ${
            activeStatus === s
              ? "border-ink text-ink"
              : "border-line text-ink hover:border-ink"
          }`}
        >
          <span
            className="h-2.5 w-2.5"
            style={{ background: STATUS_HEX[s] }}
          />
          {STATUS_META[s].label} {byStatus[s] ?? 0}
        </button>
      ))}

      <span className="mx-1 h-6 w-0.5 bg-line" />

      {bySize.map((s) => (
        <button
          key={s.size}
          onClick={() => setParam("size", s.size)}
          className={`${chipBase} ${
            activeSize === s.size
              ? "border-ink text-ink"
              : "border-line text-ink-2 hover:border-ink hover:text-ink"
          }`}
        >
          {s.size.replace("yd", " yd")} · {s.total}
        </button>
      ))}
    </div>
  );
}
