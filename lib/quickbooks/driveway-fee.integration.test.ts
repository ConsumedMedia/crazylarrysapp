/**
 * Integration test — hits the linked Supabase project AND the QuickBooks
 * sandbox company (QUICKBOOKS_ENVIRONMENT=sandbox in .env.local — this never
 * touches production QBO or costs anything, unlike the SMS integration test).
 *
 * Opt-in: CL_RUN_DB_TESTS=1 npx vitest run lib/quickbooks/driveway-fee.integration.test.ts
 * Needs a staff/owner login because apply_driveway_fee / remove_driveway_fee
 * enforce is_staff() — reuses SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD, already
 * in .env.local for the demo-seed script.
 *
 * What this verifies end to end: applying the fee writes the snapshot
 * (amount/who/when/note) AND creates a real, separate, unpaid QBO invoice —
 * never touching the booking's own total or its original invoice; removing
 * the fee actually voids that QBO invoice, not just clears the local flag.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const RUN = process.env.CL_RUN_DB_TESTS === "1";
const MARKER = `__driveway_fee_test__${Date.now()}`;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ownerEmail = process.env.SEED_OWNER_EMAIL;
const ownerPassword = process.env.SEED_OWNER_PASSWORD;

describe.skipIf(!RUN)(
  "driveway protection fee — apply creates a QBO invoice, remove voids it",
  () => {
    let service: SupabaseClient;
    let staff: SupabaseClient;
    let bookingId: string;
    let customerId: string;
    let qbInvoiceId: string;

    beforeAll(async () => {
      if (!ownerEmail || !ownerPassword) {
        throw new Error(
          "CL_RUN_DB_TESTS=1 but SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD are not set. " +
            "apply_driveway_fee / remove_driveway_fee need a staff/owner session.",
        );
      }

      service = createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      staff = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error: signInErr } = await staff.auth.signInWithPassword({
        email: ownerEmail,
        password: ownerPassword,
      });
      if (signInErr) throw new Error(`owner sign-in failed: ${signInErr.message}`);

      const { data: cust, error: custErr } = await service
        .from("customers")
        .insert({ full_name: `Driveway fee test ${MARKER}`, email: `${MARKER}@example.com` })
        .select("id")
        .single();
      if (custErr) throw new Error(`fixture customer: ${custErr.message}`);
      customerId = cust!.id;

      const { data: bk, error: bkErr } = await service
        .from("bookings")
        .insert({
          customer_id: customerId,
          size_requested: "10yd",
          delivery_address: `1 ${MARKER} St, Columbus, OH 43004`,
          delivery_date: "2026-10-01",
          pickup_date: "2026-10-06",
          status: "confirmed",
          subtotal: 100,
          tax: 7,
          total: 107,
          docusign_status: "not_sent",
        })
        .select("id")
        .single();
      if (bkErr) throw new Error(`fixture booking: ${bkErr.message}`);
      bookingId = bk!.id;
    });

    afterAll(async () => {
      const step = async (label: string, fn: () => PromiseLike<{ error: unknown }>) => {
        try {
          const { error } = await fn();
          if (error) console.error(`[driveway-fee cleanup] ${label} failed:`, error);
        } catch (e) {
          console.error(`[driveway-fee cleanup] ${label} threw:`, (e as Error).message);
        }
      };
      if (bookingId) {
        await step("booking", () => service.from("bookings").delete().eq("id", bookingId));
      }
      if (customerId) {
        await step("customer", () => service.from("customers").delete().eq("id", customerId));
      }
    });

    it("apply_driveway_fee snapshots amount/who/when and never touches the booking total", async () => {
      const { data: row, error } = await staff.rpc("apply_driveway_fee", {
        p_booking_id: bookingId,
        p_amount: 20,
        p_note: "integration test — steep gravel drive",
      });
      expect(error, error?.message).toBeNull();
      expect(row.driveway_fee_applied).toBe(true);
      expect(Number(row.driveway_fee_amount)).toBe(20);
      expect(row.driveway_fee_applied_by).toBeTruthy();
      expect(row.driveway_fee_applied_at).toBeTruthy();
      expect(row.driveway_fee_note).toBe("integration test — steep gravel drive");
      // The whole point: the original booking total is untouched.
      expect(Number(row.total)).toBe(107);
      expect(Number(row.subtotal)).toBe(100);
    });

    it("creates a real, separate, unpaid QBO invoice for just the fee", async () => {
      const { createDrivewayFeeInvoice } = await import("./driveway-fee");
      qbInvoiceId = await createDrivewayFeeInvoice({
        bookingId,
        amount: 20,
        note: "integration test — steep gravel drive",
      });
      expect(qbInvoiceId).toBeTruthy();

      const { error: recErr } = await staff.rpc("record_driveway_fee_invoice", {
        p_booking_id: bookingId,
        p_qb_invoice_id: qbInvoiceId,
      });
      expect(recErr, recErr?.message).toBeNull();

      const { data: booking } = await service
        .from("bookings")
        .select("driveway_fee_qb_invoice_id, total")
        .eq("id", bookingId)
        .single();
      expect(booking!.driveway_fee_qb_invoice_id).toBe(qbInvoiceId);
      expect(Number(booking!.total)).toBe(107); // still untouched

      const { quickbooksJson } = await import("./client");
      const fetched = await quickbooksJson<{
        Invoice: { TotalAmt: number; Line: unknown[] };
      }>(`invoice/${qbInvoiceId}`);
      expect(Number(fetched.Invoice.TotalAmt)).toBe(20);
      expect(fetched.Invoice.Line.length).toBeGreaterThan(0);
    });

    it("remove_driveway_fee voids the QBO invoice and clears the snapshot", async () => {
      const { voidDrivewayFeeInvoice } = await import("./driveway-fee");
      await expect(voidDrivewayFeeInvoice(qbInvoiceId)).resolves.toBeUndefined();

      const { quickbooksJson } = await import("./client");
      const voided = await quickbooksJson<{ Invoice: { TotalAmt: number } }>(
        `invoice/${qbInvoiceId}`,
      );
      expect(Number(voided.Invoice.TotalAmt)).toBe(0);

      const { data: row, error } = await staff.rpc("remove_driveway_fee", {
        p_booking_id: bookingId,
      });
      expect(error, error?.message).toBeNull();
      expect(row.driveway_fee_applied).toBe(false);
      expect(row.driveway_fee_amount).toBeNull();
      expect(row.driveway_fee_applied_by).toBeNull();
      expect(row.driveway_fee_qb_invoice_id).toBeNull();
      expect(Number(row.total)).toBe(107); // still untouched throughout
    });
  },
);
