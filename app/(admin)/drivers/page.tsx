import Link from "next/link";
import { requireStaff } from "@/lib/auth/requireStaff";
import { listDrivers } from "@/lib/dispatch/queries";
import { listTrucks, listCandidateProfiles } from "@/lib/drivers/manage";
import { AddDriver, DriverRowEditor } from "./_components/DriverForms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Drivers · Crazy Larry's" };

export default async function DriversPage() {
  await requireStaff();
  const [drivers, trucks, candidates] = await Promise.all([
    listDrivers(),
    listTrucks(),
    listCandidateProfiles(),
  ]);

  return (
    <div className="flex flex-col gap-4 p-4 md:p-7">
      <div className="flex flex-wrap items-end justify-between gap-3.5">
        <div>
          <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
            Drivers
          </h1>
          <p className="text-[12px] text-ink-2">
            {drivers.length} driver{drivers.length === 1 ? "" : "s"} ·{" "}
            <Link href="/dispatch" className="underline">
              Dispatch board →
            </Link>
          </p>
        </div>
        <AddDriver candidates={candidates} trucks={trucks} />
      </div>

      <div className="overflow-x-auto border-2 border-line-strong">
        <table className="w-full min-w-[640px] border-collapse bg-surface text-[13px]">
          <thead>
            <tr className="border-b-2 border-line-strong text-left text-[10px] font-extrabold uppercase tracking-[0.1em] text-ink-3">
              <th className="px-3 py-2.5">Name</th>
              <th className="px-3 py-2.5">Phone</th>
              <th className="px-3 py-2.5">Truck</th>
              <th className="px-3 py-2.5">Vehicle</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {drivers.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-ink-2">
                  No drivers yet.
                </td>
              </tr>
            )}
            {drivers.map((d) => (
              <DriverRowEditor key={d.id} driver={d} trucks={trucks} />
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[12px] text-ink-3">
        A driver needs a login (Supabase Auth). Invite them there first; unlinked
        profiles show in &quot;Add a driver.&quot; Adding a driver promotes their
        account to the <code>driver</code> role.
      </p>
    </div>
  );
}
