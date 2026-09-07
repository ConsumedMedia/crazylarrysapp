import Link from "next/link";
import { listDeployedUnits } from "@/lib/fleet/map";
import { DeployedMap } from "./DeployedMap";

export async function DeployedUnitsMap() {
  const units = await listDeployedUnits();
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_JS_API_KEY || null;
  const unmapped = units.filter((u) => u.lat === null || u.lng === null).length;

  return (
    <section className="border-2 border-line-strong bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b-2 border-line-strong px-4 py-3">
        <h2 className="text-[15px] font-extrabold">Metro Columbus · where the cans are</h2>
        <Link href="/fleet" className="text-[11px] font-extrabold text-ink-2 hover:text-ink">
          Fleet status board →
        </Link>
      </div>

      {units.length === 0 ? (
        <p className="p-6 text-center text-[13px] text-ink-2">Nothing deployed right now.</p>
      ) : (
        <>
          <DeployedMap pins={units} apiKey={apiKey} />
          <p className="border-t border-line px-4 py-2 text-[12px] text-ink-2">
            {units.length} unit{units.length === 1 ? "" : "s"} on site
            {unmapped > 0 && ` · ${unmapped} couldn't be placed (address didn't geocode)`}
          </p>
        </>
      )}
    </section>
  );
}
