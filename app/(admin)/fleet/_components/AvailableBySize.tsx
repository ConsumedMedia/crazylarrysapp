import type { FleetSummary } from "@/lib/dumpsters/types";
import { BRAND_HEX } from "@/lib/design/tokens";

export function AvailableBySize({ bySize }: { bySize: FleetSummary["bySize"] }) {
  return (
    <section className="border-2 border-line-strong bg-surface">
      <div className="flex items-baseline justify-between border-b-2 border-line-strong px-4 py-3">
        <h2 className="text-[15px] font-extrabold">Available by size</h2>
        <span className="text-[11px] text-ink-3">bookable now</span>
      </div>
      <div className="flex flex-col gap-3.5 p-4">
        {bySize.map((s) => (
          <div key={s.size}>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-[13px] font-extrabold">
                {s.size.replace("yd", " yd")}
              </span>
              <span className="text-[12px] text-ink-2">
                <strong className="cl-nums text-[15px] text-ink">
                  {s.available}
                </strong>{" "}
                of {s.total} free
              </span>
            </div>
            <div className="flex h-3 gap-0.5">
              {Array.from({ length: s.total }).map((_, i) => (
                <div
                  key={i}
                  className="flex-1"
                  style={{
                    background:
                      i < s.available ? BRAND_HEX.teal : "var(--cl-line)",
                  }}
                />
              ))}
              {s.total === 0 && (
                <div className="flex-1 bg-line" aria-hidden />
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
