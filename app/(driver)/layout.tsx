import { myTodaySummary } from "@/lib/driver/queries";
import { BottomTabNav } from "./driver/_components/BottomTabNav";

export const dynamic = "force-dynamic";

function fmtDate(d: string) {
  return new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function DriverLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const summary = await myTodaySummary();

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col bg-bg text-ink">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b-[3px] border-pink bg-rail-bg px-4 py-3">
        <div className="grid h-9 w-9 flex-none place-items-center bg-pink text-[13px] font-black text-white">
          CL
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-black leading-tight text-white">
            {summary.driverName}
          </div>
          <div className="truncate text-[11px] font-bold text-rail-ink-2">
            {summary.truckNickname ? `${summary.truckNickname} · ` : ""}
            {fmtDate(summary.date)}
          </div>
        </div>
        <div className="flex-none text-right">
          <div className="cl-nums text-[20px] font-black leading-none text-white">
            {summary.jobsToGo}
          </div>
          <div className="text-[9px] font-extrabold uppercase tracking-[0.14em] text-rail-ink-2">
            left today
          </div>
        </div>
      </header>
      {!summary.active && (
        <p className="border-b-2 border-orange bg-orange-tint px-4 py-2 text-[12px] font-semibold text-orange-tint-ink">
          Your driver account is inactive. Talk to the office.
        </p>
      )}
      <main className="flex-1 p-4">{children}</main>
      <BottomTabNav />
    </div>
  );
}
