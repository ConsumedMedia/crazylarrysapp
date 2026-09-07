import { myDriverProfile } from "@/lib/driver/queries";
import { signOutAction } from "@/lib/auth/actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Me · Crazy Larry's" };

export default async function DriverMePage() {
  const profile = await myDriverProfile();

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[22px] font-black leading-tight tracking-[-0.02em]">Me</h1>

      <div className="border-2 border-line-strong bg-surface p-4">
        <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
          Name
        </div>
        <div className="mt-1 text-[17px] font-bold">{profile.fullName}</div>

        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3">
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.13em] text-ink-3">
              Phone
            </div>
            <div className="cl-nums mt-0.5 text-[14px] font-bold">
              {profile.phone ?? "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.13em] text-ink-3">
              Truck
            </div>
            <div className="mt-0.5 text-[14px] font-bold">
              {profile.truckNickname ?? "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.13em] text-ink-3">
              Vehicle
            </div>
            <div className="mt-0.5 text-[14px] font-bold">
              {profile.vehicleInfo ?? "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.13em] text-ink-3">
              Status
            </div>
            <div
              className={`mt-0.5 inline-block px-1.5 py-0.5 text-[11px] font-extrabold uppercase ${
                profile.active
                  ? "bg-teal-tint text-teal-tint-ink"
                  : "bg-tint text-ink-2"
              }`}
            >
              {profile.active ? "Active" : "Inactive"}
            </div>
          </div>
        </div>
      </div>

      <form action={signOutAction}>
        <button className="w-full border-2 border-ink px-4 py-3 text-[13px] font-extrabold hover:bg-tint">
          Sign out
        </button>
      </form>
    </div>
  );
}
