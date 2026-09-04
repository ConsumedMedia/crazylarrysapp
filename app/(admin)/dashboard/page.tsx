import { requireStaff } from "@/lib/auth/requireStaff";
import { getOverview, getRevenueToday } from "@/lib/dashboard/queries";
import { StatusDonut } from "../fleet/_components/StatusDonut";
import { StatCard } from "./_components/StatCard";
import { MovementsToday } from "./_components/MovementsToday";
import { NeedsAction } from "./_components/NeedsAction";
import { NotificationHealthBanner } from "./_components/NotificationHealthBanner";
import { RevenueToday } from "./_components/RevenueToday";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview · Crazy Larry's" };

export default async function DashboardPage() {
  const staff = await requireStaff();
  const overview = await getOverview();
  const revenueToday =
    staff.role === "owner" ? await getRevenueToday() : null;

  return (
    <div className="flex flex-col gap-4 p-4 md:p-7">
      <div>
        <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
          Overview
        </h1>
        <p className="text-[12px] text-ink-2">
          Today, at a glance — {overview.movementsToday.length} moves,{" "}
          {overview.counts.overdue} overdue, {overview.counts.unassigned} unassigned.
        </p>
      </div>

      <NotificationHealthBanner health={overview.notificationHealth} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Deliveries today" value={overview.counts.deliveriesToday} />
        <StatCard label="Pickups today" value={overview.counts.pickupsToday} />
        <StatCard label="Active rentals" value={overview.counts.activeRentals} />
        <StatCard
          label="Overdue"
          value={overview.counts.overdue}
          href="/bookings?status=overdue"
          tone={overview.counts.overdue > 0 ? "orange" : "default"}
        />
        <StatCard
          label="Unassigned"
          value={overview.counts.unassigned}
          href="/dispatch"
          tone={overview.counts.unassigned > 0 ? "pink" : "default"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.8fr_1fr]">
        <MovementsToday rows={overview.movementsToday} date={overview.today} />

        <div className="flex flex-col gap-4">
          {revenueToday !== null && <RevenueToday amount={revenueToday} />}
          <StatusDonut total={overview.fleet.total} byStatus={overview.fleet.byStatus} />
          <NeedsAction
            overdueBookings={overview.overdueBookings}
            unassignedJobs={overview.unassignedJobs}
          />
        </div>
      </div>
    </div>
  );
}
