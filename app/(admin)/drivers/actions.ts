"use server";

import { revalidatePath } from "next/cache";
import {
  createDriver,
  updateDriver,
  listOpenJobsForDriver,
  DriverManageError,
  type DriverOpenJob,
} from "@/lib/drivers/manage";
import { NotAuthorizedError } from "@/lib/auth/requireStaff";

export interface DriverActionState {
  ok: boolean;
  error?: string;
  message?: string;
  openJobs?: DriverOpenJob[];
}

function toState(e: unknown): DriverActionState {
  if (e instanceof DriverManageError || e instanceof NotAuthorizedError) {
    return { ok: false, error: e.message };
  }
  console.error("[driver action]", e);
  return { ok: false, error: "Something went wrong." };
}

export async function createDriverAction(
  _prev: DriverActionState,
  formData: FormData,
): Promise<DriverActionState> {
  try {
    await createDriver({
      profile_id: String(formData.get("profile_id") ?? ""),
      full_name: String(formData.get("full_name") ?? ""),
      phone: String(formData.get("phone") ?? "") || null,
      vehicle_info: String(formData.get("vehicle_info") ?? "") || null,
      truck_id: String(formData.get("truck_id") ?? "") || null,
    });
    revalidatePath("/drivers");
    return { ok: true, message: "Driver added." };
  } catch (e) {
    return toState(e);
  }
}

/**
 * Contact info only (name/phone/vehicle) — optimistic-safe. No dispatch or
 * inventory effect, so the UI updates before this resolves; see
 * DriverForms.tsx.
 */
export async function updateDriverContactAction(
  _prev: DriverActionState,
  formData: FormData,
): Promise<DriverActionState> {
  try {
    await updateDriver(String(formData.get("driver_id") ?? ""), {
      full_name: String(formData.get("full_name") ?? ""),
      phone: String(formData.get("phone") ?? "") || null,
      vehicle_info: String(formData.get("vehicle_info") ?? "") || null,
    });
    revalidatePath("/drivers");
    return { ok: true, message: "Saved." };
  } catch (e) {
    return toState(e);
  }
}

/**
 * Truck (re)assignment — stays server-confirmed. This is dispatch-relevant
 * (a truck can only carry one driver; assigning one here frees it from
 * whoever had it), so the UI waits for the real result.
 */
export async function updateDriverTruckAction(
  _prev: DriverActionState,
  formData: FormData,
): Promise<DriverActionState> {
  try {
    await updateDriver(String(formData.get("driver_id") ?? ""), {
      truck_id: String(formData.get("truck_id") ?? "") || null,
    });
    revalidatePath("/drivers");
    revalidatePath("/dispatch");
    return { ok: true, message: "Truck updated." };
  } catch (e) {
    return toState(e);
  }
}

export async function toggleDriverActiveAction(
  _prev: DriverActionState,
  formData: FormData,
): Promise<DriverActionState> {
  try {
    const driverId = String(formData.get("driver_id") ?? "");
    const active = formData.get("active") === "true";
    if (!active) {
      // Same rules as turning off driver access on the Users page: refuse while
      // the driver still has assigned jobs, and release their truck so it can
      // go to someone else (reactivating doesn't restore it).
      const openJobs = await listOpenJobsForDriver(driverId);
      if (openJobs.length) {
        return {
          ok: false,
          error: `Can't deactivate: this driver has ${openJobs.length} open job(s). Reassign them first.`,
          openJobs,
        };
      }
    }
    await updateDriver(driverId, active ? { active } : { active, truck_id: null });
    revalidatePath("/drivers");
    revalidatePath("/dispatch");
    return { ok: true };
  } catch (e) {
    return toState(e);
  }
}
