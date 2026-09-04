import type { MovementRow } from "@/lib/dashboard/queries";

const JOB_STATUS_LABEL: Record<string, string> = {
  unassigned: "Unassigned",
  assigned: "Assigned",
  completed: "Done",
};

function Badge({ type }: { type: "delivery" | "pickup" }) {
  return (
    <span
      className={`px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.08em] ${
        type === "delivery"
          ? "bg-teal-tint text-teal-tint-ink"
          : "bg-purple-tint text-purple-tint-ink"
      }`}
    >
      {type === "delivery" ? "Drop" : "Pickup"}
    </span>
  );
}

export function MovementsToday({ rows, date }: { rows: MovementRow[]; date: string }) {
  const fmtDate = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  return (
    <section className="border-2 border-line-strong bg-surface">
      <div className="border-b-2 border-line-strong px-4 py-3">
        <h2 className="text-[15px] font-extrabold">Today&apos;s movements</h2>
        <p className="text-[11px] text-ink-2">{fmtDate}</p>
      </div>
      {rows.length === 0 ? (
        <p className="p-6 text-center text-[13px] text-ink-2">
          Nothing scheduled for today.
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((r) => (
            <li key={r.jobId} className="flex items-center gap-3 border-b border-line px-4 py-3 text-[13px] last:border-b-0">
              <Badge type={r.type} />
              <span className="w-14 flex-none font-extrabold">{r.size.replace("yd", " yd")}</span>
              <span className="min-w-0 flex-1 truncate">
                <a href={`/bookings/${r.bookingId}`} className="hover:underline">
                  {r.address}
                </a>
                <span className="text-ink-2"> · {r.customerName}</span>
              </span>
              <span className="hidden text-ink-2 sm:inline">
                {r.driverName ?? "No driver"}
              </span>
              <span className="ml-auto flex-none border-2 border-line px-1.5 py-0.5 text-[10px] font-extrabold uppercase">
                {JOB_STATUS_LABEL[r.status] ?? r.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
