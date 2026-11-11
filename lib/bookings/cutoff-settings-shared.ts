/**
 * Order-cutoff settings: types, the allowed times and form parsing. Pure, so
 * the Settings panel and tests can use it. The database enforces the same
 * limits (cl_booking_settings_cutoff_time_check, migration 20261111000000).
 */
import { formatCutoffTime } from "./cutoff-shared";

export interface BookingCutoffSettings {
  cutoff_enabled: boolean;
  /** "HH:MM", yard time. */
  cutoff_time: string;
  updated_at: string | null;
}

export type BookingCutoffInput = Omit<BookingCutoffSettings, "updated_at">;

export const DEFAULT_CUTOFF_TIME = "15:00";

/** 03:00 to 23:45 in 15-minute steps: never inside a daylight-saving change (2 AM). */
export const CUTOFF_TIMES: string[] = Array.from({ length: (23 - 3) * 4 + 4 }, (_, i) => {
  const minutes = 3 * 60 + i * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

export const CUTOFF_TIME_OPTIONS = CUTOFF_TIMES.map((value) => ({ value, label: formatCutoffTime(value) }));

export function isAllowedCutoffTime(v: string): boolean {
  return CUTOFF_TIMES.includes(v);
}

export function parseCutoffSettingsForm(
  fd: FormData,
): { ok: true; value: BookingCutoffInput } | { ok: false; error: string } {
  const time = String(fd.get("cutoff_time") ?? "").trim();
  if (!isAllowedCutoffTime(time)) {
    return { ok: false, error: "Pick a cutoff time between 3:00 AM and 11:45 PM, in 15-minute steps." };
  }
  return { ok: true, value: { cutoff_enabled: fd.get("cutoff_enabled") === "on", cutoff_time: time } };
}
