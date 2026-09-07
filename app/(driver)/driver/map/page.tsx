import Link from "next/link";
import { myJobs } from "@/lib/driver/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Map · Crazy Larry's" };

function embedUrl(addresses: string[], apiKey: string): string {
  const enc = (a: string) => encodeURIComponent(a);
  if (addresses.length === 1) {
    return `https://www.google.com/maps/embed/v1/place?key=${apiKey}&q=${enc(addresses[0])}`;
  }
  const origin = addresses[0];
  const destination = addresses[addresses.length - 1];
  const waypoints = addresses.slice(1, -1);
  let url = `https://www.google.com/maps/embed/v1/directions?key=${apiKey}&origin=${enc(origin)}&destination=${enc(destination)}`;
  if (waypoints.length > 0) {
    url += `&waypoints=${waypoints.map(enc).join("%7C")}`;
  }
  return url;
}

export default async function DriverMapPage() {
  const { jobs } = await myJobs();
  const open = jobs.filter((j) => j.status !== "completed");
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY;

  const next = open[0];
  const rest = open.slice(1);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[22px] font-black leading-tight tracking-[-0.02em]">
        Today&apos;s route
      </h1>

      {open.length === 0 ? (
        <p className="border-2 border-line bg-surface p-4 text-[14px] text-ink-2">
          No stops left to route today.
        </p>
      ) : apiKey ? (
        <div className="-mx-4 border-b-2 border-line-strong">
          <iframe
            title="Today's route"
            width="100%"
            height="260"
            style={{ border: 0 }}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            src={embedUrl(
              open.map((j) => j.delivery_address),
              apiKey,
            )}
          />
        </div>
      ) : (
        <div className="flex h-[220px] flex-col items-center justify-center gap-1 border-2 border-dashed border-line-strong bg-surface-2 p-4 text-center">
          <div className="text-[13px] font-bold text-ink-2">Map not configured yet</div>
          <div className="text-[12px] text-ink-3">
            Set NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY to show today&apos;s route here.
          </div>
        </div>
      )}

      {next && (
        <div className="border-2 border-teal bg-surface p-3.5">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 flex-none place-items-center bg-teal text-[14px] font-extrabold text-white">
              1
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-teal-tint-ink">
                Next stop
              </div>
              <div className="truncate text-[16px] font-bold leading-tight">
                {next.customer_name}
              </div>
              <div className="truncate text-[13px] text-ink-2">
                {next.delivery_address} · {next.type} {next.size_requested.replace("yd", " yd")}
              </div>
            </div>
          </div>
          <a
            href={`https://maps.google.com/?q=${encodeURIComponent(next.delivery_address)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 flex w-full items-center justify-between bg-ink px-4 py-3.5 text-[14px] font-extrabold text-surface"
          >
            Navigate there <span>→</span>
          </a>
        </div>
      )}

      {rest.length > 0 && (
        <div className="border-2 border-line-strong bg-surface">
          <div className="border-b-2 border-line-strong px-3.5 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.16em]">
            Rest of the run
          </div>
          {rest.map((j, i) => (
            <Link
              key={j.id}
              href={`/driver/${j.id}`}
              className="flex items-center gap-3 border-b border-line px-3.5 py-3 last:border-b-0"
            >
              <div className="grid h-7 w-7 flex-none place-items-center bg-pink text-[12px] font-extrabold text-white">
                {i + 2}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-bold">{j.customer_name}</div>
                <div className="truncate text-[12px] text-ink-2">{j.delivery_address}</div>
              </div>
              <span className="flex-none text-[11px] font-extrabold uppercase text-ink-3">
                {j.type}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
