"use server";

import { revalidatePath } from "next/cache";
import {
  updateSizePricing,
  updatePricingSettings,
} from "@/lib/bookings/pricing";
import { isDumpsterSize } from "@/lib/dumpsters/state-machine";
import { NotAuthorizedError } from "@/lib/auth/requireStaff";

export interface SettingsState {
  ok: boolean;
  error?: string;
  message?: string;
}

function toState(e: unknown): SettingsState {
  if (e instanceof NotAuthorizedError) return { ok: false, error: e.message };
  const msg = e instanceof Error ? e.message : "Something went wrong.";
  return { ok: false, error: msg };
}

function money(v: FormDataEntryValue | null): number {
  const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
}

export async function saveSizePricingAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const size = String(formData.get("size") ?? "");
  if (!isDumpsterSize(size)) return { ok: false, error: "Unknown size." };
  const base = money(formData.get("base_price"));
  if (Number.isNaN(base)) return { ok: false, error: "Enter a valid price." };
  const active = formData.get("is_active") === "on";
  if (active && base <= 0) {
    return { ok: false, error: "Set a price above $0 before activating." };
  }
  try {
    await updateSizePricing(size, { base_price: base, is_active: active });
    revalidatePath("/settings");
    return { ok: true, message: `${size.replace("yd", " yd")} saved.` };
  } catch (e) {
    return toState(e);
  }
}

export async function saveGlobalSettingsAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const extraDay = money(formData.get("extra_day_rate"));
  const overageTon = money(formData.get("overage_ton_rate"));
  const taxPct = Number(String(formData.get("tax_rate_pct") ?? ""));
  if (Number.isNaN(extraDay) || Number.isNaN(overageTon)) {
    return { ok: false, error: "Enter valid dollar amounts." };
  }
  if (!Number.isFinite(taxPct) || taxPct < 0 || taxPct >= 100) {
    return { ok: false, error: "Tax rate must be a percentage between 0 and 100." };
  }
  try {
    await updatePricingSettings({
      extra_day_rate: extraDay,
      overage_ton_rate: overageTon,
      tax_rate: Math.round((taxPct / 100) * 10000) / 10000,
      tax_jurisdiction: String(formData.get("tax_jurisdiction") ?? "").trim() || null,
      tax_verified: formData.get("tax_verified") === "on",
      tax_verified_note:
        String(formData.get("tax_verified_note") ?? "").trim() || null,
    });
    revalidatePath("/settings");
    return { ok: true, message: "Global rates saved." };
  } catch (e) {
    return toState(e);
  }
}
