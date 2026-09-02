import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { assertStaff } from "@/lib/auth/requireStaff";
import { DUMPSTER_SIZES, type DumpsterSize } from "@/lib/dumpsters/state-machine";

export interface SizePricing {
  size: DumpsterSize;
  base_price: number;
  included_days: number;
  included_tons: number;
  is_active: boolean;
}

export interface PricingSettings {
  extra_day_rate: number;
  overage_ton_rate: number;
  tax_rate: number;
  tax_jurisdiction: string | null;
  tax_verified: boolean;
  tax_verified_note: string | null;
}

export interface PricingConfig {
  sizes: SizePricing[];
  settings: PricingSettings;
  /** true when every size is active with a real base_price and tax_rate > 0. */
  bookingReady: boolean;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0);
}

/** Public-facing read (customer flow) — service role, no auth needed. */
export async function getPricingConfig(): Promise<PricingConfig> {
  const supabase = createServiceClient();
  const [{ data: sizeRows }, { data: settingsRow }] = await Promise.all([
    supabase.from("cl_pricing").select("*"),
    supabase.from("cl_pricing_settings").select("*").eq("id", true).single(),
  ]);

  const sizes: SizePricing[] = DUMPSTER_SIZES.map((size) => {
    const r = (sizeRows ?? []).find(
      (x: { size: string }) => x.size === size,
    ) as Record<string, unknown> | undefined;
    return {
      size,
      base_price: num(r?.base_price),
      included_days: num(r?.included_days) || 5,
      included_tons: num(r?.included_tons) || 1,
      is_active: Boolean(r?.is_active),
    };
  });

  const s = (settingsRow ?? {}) as Record<string, unknown>;
  const settings: PricingSettings = {
    extra_day_rate: num(s.extra_day_rate),
    overage_ton_rate: num(s.overage_ton_rate),
    tax_rate: num(s.tax_rate),
    tax_jurisdiction: (s.tax_jurisdiction as string | null) ?? null,
    tax_verified: Boolean(s.tax_verified),
    tax_verified_note: (s.tax_verified_note as string | null) ?? null,
  };

  const bookingReady =
    settings.tax_rate > 0 &&
    sizes.every((z) => z.is_active && z.base_price > 0);

  return { sizes, settings, bookingReady };
}

/** Compute the display quote for a size (DB booking_quote is authoritative). */
export function quoteFor(
  config: PricingConfig,
  size: DumpsterSize,
): { subtotal: number; tax: number; total: number } | null {
  const z = config.sizes.find((x) => x.size === size);
  if (!z || !z.is_active || z.base_price <= 0 || config.settings.tax_rate <= 0) {
    return null;
  }
  const subtotal = z.base_price;
  const tax = Math.round(subtotal * config.settings.tax_rate * 100) / 100;
  return { subtotal, tax, total: subtotal + tax };
}

// --- owner writes -----------------------------------------------------------

export async function updateSizePricing(
  size: DumpsterSize,
  patch: { base_price?: number; is_active?: boolean; included_days?: number; included_tons?: number },
): Promise<void> {
  const staff = await assertStaff();
  if (staff.role !== "owner") {
    throw new Error("Only the owner can edit pricing.");
  }
  const supabase = createClient();
  const { error } = await supabase
    .from("cl_pricing")
    .update({ ...patch, updated_by: staff.userId })
    .eq("size", size);
  if (error) throw new Error(error.message);
}

export async function updatePricingSettings(
  patch: Partial<PricingSettings>,
): Promise<void> {
  const staff = await assertStaff();
  if (staff.role !== "owner") {
    throw new Error("Only the owner can edit pricing.");
  }
  const supabase = createClient();
  const { error } = await supabase
    .from("cl_pricing_settings")
    .update({ ...patch, updated_by: staff.userId })
    .eq("id", true);
  if (error) throw new Error(error.message);
}
