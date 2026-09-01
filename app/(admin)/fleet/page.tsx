import { listFleet, fleetSummary, getDumpster } from "@/lib/dumpsters/queries";
import { isDumpsterStatus, isDumpsterSize } from "@/lib/dumpsters/state-machine";
import { FilterBar } from "./_components/FilterBar";
import { StatusDonut } from "./_components/StatusDonut";
import { AvailableBySize } from "./_components/AvailableBySize";
import { CanTile } from "./_components/CanTile";
import { CanDetailPanel } from "./_components/CanDetailPanel";
import { AddCan } from "./_components/AddCan";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fleet status board · Crazy Larry's" };

type SP = { status?: string; size?: string; sel?: string };

function qs(base: SP, overrides: Partial<SP>): string {
  const merged = { ...base, ...overrides };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v) p.set(k, v);
  }
  const s = p.toString();
  return s ? `/fleet?${s}` : "/fleet";
}

export default async function FleetPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const [fleet, summary] = await Promise.all([listFleet(), fleetSummary()]);

  const activeStatus = isDumpsterStatus(searchParams.status)
    ? searchParams.status
    : null;
  const activeSize = isDumpsterSize(searchParams.size)
    ? searchParams.size
    : null;

  const visible = fleet.filter(
    (u) =>
      (activeStatus === null || u.status === activeStatus) &&
      (activeSize === null || u.size === activeSize),
  );

  const selectedUnit = searchParams.sel
    ? fleet.find(
        (u) => u.unit_number === String(searchParams.sel).toUpperCase(),
      )
    : undefined;
  const detail = selectedUnit ? await getDumpster(selectedUnit.id) : null;

  const cleanParams: SP = {
    status: activeStatus ?? undefined,
    size: activeSize ?? undefined,
    sel: searchParams.sel,
  };

  return (
    <div className="flex flex-col gap-4 p-4 md:p-7">
      <div className="flex flex-wrap items-end justify-between gap-3.5">
        <div>
          <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
            Fleet status board
          </h1>
          <p className="text-[12px] text-ink-2">
            Every can, every state, one screen
          </p>
        </div>
        <AddCan />
      </div>

      <FilterBar
        total={summary.total}
        byStatus={summary.byStatus}
        bySize={summary.bySize}
        activeStatus={activeStatus}
        activeSize={activeSize}
      />

      <div className="grid gap-4 lg:grid-cols-[1.8fr_1fr]">
        {/* Board */}
        <div className="grid grid-cols-3 content-start gap-0.5 self-start border-2 border-line-strong bg-line p-0.5 md:grid-cols-6">
          {visible.length === 0 && (
            <p className="col-span-full bg-surface p-6 text-center text-[13px] text-ink-2">
              No cans match this filter.
            </p>
          )}
          {visible.map((unit) => (
            <CanTile
              key={unit.id}
              unit={unit}
              active={selectedUnit?.id === unit.id}
              href={qs(cleanParams, {
                sel:
                  selectedUnit?.id === unit.id ? undefined : unit.unit_number,
              })}
            />
          ))}
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-4">
          {detail && (
            <CanDetailPanel
              detail={detail}
              closeHref={qs(cleanParams, { sel: undefined })}
            />
          )}
          <StatusDonut total={summary.total} byStatus={summary.byStatus} />
          <AvailableBySize bySize={summary.bySize} />
        </div>
      </div>
    </div>
  );
}
