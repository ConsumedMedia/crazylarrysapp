"use server";

import { revalidatePath } from "next/cache";
import {
  updateSizePricing,
  updatePricingSettings,
} from "@/lib/bookings/pricing";
import { isDumpsterSize } from "@/lib/dumpsters/state-machine";
import { NotAuthorizedError, assertStaff } from "@/lib/auth/requireStaff";
import { parseAgreementModeForm, saveAgreementMode } from "@/lib/docusign/mode-settings";
import { capabilityGap, docusignCapability } from "@/lib/docusign/mode";
import { runDocusignPreflight, type PreflightResult } from "@/lib/docusign/preflight";
import { parsePayLinkSettingsForm, savePayLinkSettings } from "@/lib/pay-links/settings";
import { parseCutoffSettingsForm, saveBookingCutoffSettings } from "@/lib/bookings/cutoff-settings";
import { formatCutoffTime } from "@/lib/bookings/cutoff-shared";

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

export async function savePayLinkSettingsAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const parsed = parsePayLinkSettingsForm(formData);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  try {
    await savePayLinkSettings(parsed.value);
    revalidatePath("/settings");
    return {
      ok: true,
      message: parsed.value.enabled ? "Pay links saved — they are ON." : "Pay links saved — they are off.",
    };
  } catch (e) {
    return toState(e);
  }
}

export async function saveBookingCutoffAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const parsed = parseCutoffSettingsForm(formData);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  try {
    await saveBookingCutoffSettings(parsed.value);
    revalidatePath("/settings");
    const t = formatCutoffTime(parsed.value.cutoff_time);
    return {
      ok: true,
      message: parsed.value.cutoff_enabled
        ? `Order cutoff saved — ON at ${t} Eastern.`
        : `Order cutoff saved — off (time set to ${t}).`,
    };
  } catch (e) {
    return toState(e);
  }
}

export async function saveAgreementModeAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const parsed = parseAgreementModeForm(formData);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  try {
    await saveAgreementMode(parsed.value);
    revalidatePath("/settings");
    if (parsed.value === "attest") {
      return { ok: true, message: "Saved: /book uses the PowerForm and checkbox." };
    }
    const cap = docusignCapability();
    return {
      ok: true,
      message: cap.ok
        ? "Saved: /book uses DocuSign on this deployment now."
        : `Saved as DocuSign, but this deployment isn't set up for it (${capabilityGap(cap)}), so /book here keeps the PowerForm. Any deployment that is set up switches now: Preview and Production share this setting.`,
    };
  } catch (e) {
    return toState(e);
  }
}

export interface PreflightState {
  ran: boolean;
  error?: string;
  result?: PreflightResult;
}

/** Staff-only "Check DocuSign": read-only against DocuSign, any mode. */
export async function checkDocusignAction(): Promise<PreflightState> {
  try {
    await assertStaff();
  } catch (e) {
    return { ran: false, error: e instanceof NotAuthorizedError ? e.message : "Not allowed." };
  }
  try {
    return { ran: true, result: await runDocusignPreflight() };
  } catch {
    return { ran: true, error: "The check itself failed. Try again." };
  }
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
  const drivewayFee = money(formData.get("driveway_fee_rate"));
  const ccFeePct = Number(String(formData.get("credit_card_fee_pct") ?? ""));
  const taxPct = Number(String(formData.get("tax_rate_pct") ?? ""));
  if (Number.isNaN(extraDay) || Number.isNaN(overageTon) || Number.isNaN(drivewayFee)) {
    return { ok: false, error: "Enter valid dollar amounts." };
  }
  if (!Number.isFinite(ccFeePct) || ccFeePct < 0 || ccFeePct >= 100) {
    return { ok: false, error: "Credit card fee must be a percentage between 0 and 100." };
  }
  if (!Number.isFinite(taxPct) || taxPct < 0 || taxPct >= 100) {
    return { ok: false, error: "Tax rate must be a percentage between 0 and 100." };
  }
  try {
    await updatePricingSettings({
      extra_day_rate: extraDay,
      overage_ton_rate: overageTon,
      driveway_fee_rate: drivewayFee,
      credit_card_fee_rate: Math.round((ccFeePct / 100) * 10000) / 10000,
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
