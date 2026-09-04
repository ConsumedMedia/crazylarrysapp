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

      {drivers.length === 0 ? (
        <p className="border-2 border-line-strong bg-surface p-6 text-center text-[13px] text-ink-2">
          No drivers yet.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {drivers.map((d) => (
            <DriverRowEditor key={d.id} driver={d} trucks={trucks} />
          ))}
        </div>
      )}

      <p className="text-[12px] text-ink-3">
        A driver needs a login (Supabase Auth). Invite them there first; unlinked
        profiles show in &quot;Add a driver.&quot; Adding a driver promotes their
        account to the <code>driver</code> role.
      </p>
    </div>
  );
}
