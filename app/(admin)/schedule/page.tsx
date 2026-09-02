import Link from "next/link";
import { requireStaff } from "@/lib/auth/requireStaff";
import { listBlocks } from "@/lib/availability/blocks";
import {
  DAY_NAMES,
  MONTH_NAMES,
  monthGrid,
  addDays,
  ymd,
} from "@/lib/availability/dates";
import { BlocksPanel } from "./_components/BlocksPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Schedule · Crazy Larry's" };

type View = "day" | "week" | "month";
type SP = { view?: string; date?: string };

function parseView(v?: string): View {
  return v === "day" || v === "week" ? v : "month";
}

function anchorFrom(sp: SP): Date {
  if (sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date)) {
    const [y, m, d] = sp.date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: SP;
}) {
  await requireStaff();

  const view = parseView(searchParams.view);
  const anchor = anchorFrom(searchParams);

  // Range to load blocks for, per view.
  let rangeFrom: string;
  let rangeTo: string;
  let grid: ReturnType<typeof monthGrid> | null = null;

  if (view === "month") {
    grid = monthGrid(anchor);
    rangeFrom = grid.from;
    rangeTo = grid.to;
  } else if (view === "week") {
    const start = new Date(anchor);
    start.setUTCDate(anchor.getUTCDate() - anchor.getUTCDay());
    rangeFrom = ymd(start);
    rangeTo = addDays(rangeFrom, 6);
  } else {
    rangeFrom = ymd(anchor);
    rangeTo = rangeFrom;
  }

  const [blocks, allBlocks] = await Promise.all([
    listBlocks(rangeFrom, rangeTo),
    listBlocks(ymd(new Date()), addDays(ymd(new Date()), 365)),
  ]);

  const blocksOn = (date: string) =>
    blocks.filter((b) => b.start_date <= date && b.end_date >= date);

  const tab = (v: View, label: string) => {
    const params = new URLSearchParams();
    params.set("view", v);
    if (searchParams.date) params.set("date", searchParams.date);
    return (
      <Link
        href={`/schedule?${params.toString()}`}
        className={`border-2 px-3 py-1.5 text-[12px] font-extrabold uppercase tracking-[0.06em] ${
          view === v
            ? "border-ink bg-ink text-surface"
            : "border-line text-ink hover:border-ink"
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="flex flex-col gap-4 p-4 md:p-7">
      <div className="flex flex-wrap items-end justify-between gap-3.5">
        <div>
          <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
            Schedule
          </h1>
          <p className="text-[12px] text-ink-2">
            Deliveries, active rentals, and pickups across the fleet.
          </p>
        </div>
        <div className="flex gap-1.5">
          {tab("day", "Day")}
          {tab("week", "Week")}
          {tab("month", "Month")}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.8fr_1fr]">
        <div className="self-start">
          {view === "month" && grid ? (
            <div className="border-2 border-line-strong bg-surface">
              <div className="border-b-2 border-line-strong px-4 py-3 text-[17px] font-extrabold">
                {MONTH_NAMES[grid.month]} {grid.year}
              </div>
              <div className="grid grid-cols-7 gap-px bg-line p-px">
                {DAY_NAMES.map((d) => (
                  <div
                    key={d}
                    className="bg-surface py-1.5 text-center text-[10px] font-extrabold uppercase tracking-[0.1em] text-ink-3"
                  >
                    {d}
                  </div>
                ))}
                {grid.cells.map((cell) => {
                  const covering = blocksOn(cell.date);
                  return (
                    <div
                      key={cell.date}
                      className={`flex min-h-[84px] flex-col gap-1 p-1.5 ${
                        cell.inMonth ? "bg-surface" : "bg-bg"
                      }`}
                    >
                      <span
                        className={`cl-nums text-[13px] font-extrabold ${
                          cell.inMonth ? "text-ink" : "text-ink-3"
                        }`}
                      >
                        {cell.dayOfMonth}
                      </span>
                      {covering.map((b) => (
                        <span
                          key={b.id}
                          title={b.reason ?? undefined}
                          className="bg-tint px-1 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-ink-3"
                        >
                          {b.size ? `${b.size.replace("yd", "yd")} closed` : "Closed"}
                        </span>
                      ))}
                      {cell.inMonth && covering.length === 0 && (
                        <span className="mt-auto text-[9px] text-ink-3">
                          0 deliveries
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="border-2 border-line-strong bg-surface p-6">
              <div className="text-[13px] font-extrabold uppercase tracking-[0.12em] text-ink-3">
                {view === "week" ? "This week" : "This day"} · {rangeFrom}
                {view === "week" && ` – ${rangeTo}`}
              </div>
              <p className="mt-3 text-[14px] text-ink-2">
                No bookings scheduled. Deliveries, active rentals, and pickups
                will show here once bookings exist (Phase 4).
              </p>
              {blocks.length > 0 && (
                <ul className="mt-4 flex flex-col gap-1.5">
                  {blocks.map((b) => (
                    <li key={b.id} className="text-[13px]">
                      <span className="font-extrabold">
                        {b.size ? b.size.replace("yd", " yd") : "Fleet-wide"}
                      </span>{" "}
                      closed {b.start_date}
                      {b.end_date !== b.start_date && ` – ${b.end_date}`}
                      {b.reason && ` · ${b.reason}`}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <BlocksPanel blocks={allBlocks} />
      </div>
    </div>
  );
}
