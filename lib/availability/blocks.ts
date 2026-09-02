import "server-only";
import { createClient } from "@/lib/supabase/server";
import { assertStaff } from "@/lib/auth/requireStaff";
import { isDumpsterSize, type DumpsterSize } from "@/lib/dumpsters/state-machine";

export interface CalendarBlock {
  id: string;
  size: DumpsterSize | null; // null = fleet-wide
  start_date: string;
  end_date: string;
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

export class BlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockError";
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function listBlocks(
  from?: string,
  to?: string,
): Promise<CalendarBlock[]> {
  await assertStaff();
  const supabase = createClient();
  let q = supabase
    .from("calendar_blocks")
    .select("id, size, start_date, end_date, reason, created_by, created_at")
    .order("start_date", { ascending: true });

  // Overlap filter: block.start <= to AND block.end >= from
  if (to) q = q.lte("start_date", to);
  if (from) q = q.gte("end_date", from);

  const { data, error } = await q;
  if (error) throw new BlockError(error.message);
  return (data ?? []) as CalendarBlock[];
}

export async function createBlock(input: {
  size: string | null;
  start_date: string;
  end_date: string;
  reason?: string;
}): Promise<CalendarBlock> {
  const staff = await assertStaff();

  const size = input.size ?? null;
  if (size !== null && !isDumpsterSize(size)) {
    throw new BlockError("Unknown dumpster size.");
  }
  if (!ISO_DATE.test(input.start_date) || !ISO_DATE.test(input.end_date)) {
    throw new BlockError("Dates must be yyyy-mm-dd.");
  }
  if (input.end_date < input.start_date) {
    throw new BlockError("End date can't be before the start date.");
  }

  const supabase = createClient();
  const { data, error } = await supabase
    .from("calendar_blocks")
    .insert({
      size,
      start_date: input.start_date,
      end_date: input.end_date,
      reason: input.reason?.trim() || null,
      created_by: staff.userId,
    })
    .select("id, size, start_date, end_date, reason, created_by, created_at")
    .single();

  if (error) {
    // calendar_blocks_date_range_ck etc.
    throw new BlockError(error.message);
  }
  return data as CalendarBlock;
}

export async function deleteBlock(id: string): Promise<void> {
  await assertStaff();
  const supabase = createClient();
  const { error } = await supabase.from("calendar_blocks").delete().eq("id", id);
  if (error) throw new BlockError(error.message);
}
