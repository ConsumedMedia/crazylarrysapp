/**
 * Integration test — manual-booking payments against the linked Supabase
 * project AND the QuickBooks SANDBOX company. Refuses to run if
 * QUICKBOOKS_ENVIRONMENT=production.
 *
 * Safe by default (see the real-side-effect test rule):
 *   CL_RUN_DB_TESTS=1 npx vitest run lib/quickbooks/invoice-payments.integration.test.ts
 *     Creates real sandbox QBO invoices/payments (free, no one notified) but
 *     NEVER emails an invoice — createOrResendBookingInvoice(send:false).
 *
 * Live email, only with a SEPARATE explicit flag + recipient:
 *   CL_VERIFY_QBO_SEND_LIVE=1 CL_QBO_TEST_SEND_TO=you@example.com ...
 *     Additionally calls QBO's invoice/<id>/send, which emails a real invoice
 *     (from Intuit) to CL_QBO_TEST_SEND_TO.
 *
 * The customer's payment on Intuit's hosted Pay Now page is simulated by
 * posting a QBO Payment linked to the invoice via the API — the same ledger
 * record QBO creates when the link is paid — so the detection path under test
 * (reconcileInvoicePayments reading Invoice.Balance) is the real one.
 *
 * Cleanup: QBO payments are deleted and invoices voided; DB rows deleted per
 * id, each step independently guarded.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const RUN = process.env.CL_RUN_DB_TESTS === "1";
const LIVE_SEND = process.env.CL_VERIFY_QBO_SEND_LIVE === "1";
const SEND_TO = process.env.CL_QBO_TEST_SEND_TO;
const MARKER = `__qbo_pay_test__${Date.now()}`;
// A syntactically valid address on a reserved domain: QBO needs a valid
// BillEmail to generate InvoiceLink, and nothing is ever sent to it.
const SAFE_EMAIL = `qbo-pay-test-${Date.now()}@example.com`;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const staffEmail = process.env.CL_TEST_STAFF_EMAIL ?? process.env.SEED_OWNER_EMAIL;
const staffPassword = process.env.CL_TEST_STAFF_PASSWORD ?? process.env.SEED_OWNER_PASSWORD;

function farDate(offsetDays: number): string {
  return new Date(Date.UTC(2027, 8, 1) + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

type QboJson = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

describe.skipIf(!RUN)(
  `manual-booking payments vs QBO sandbox${LIVE_SEND ? " (LIVE — real invoice email)" : " (safe mode — no email)"}`,
  () => {
    let service: SupabaseClient;
    let staff: SupabaseClient;
    let qbo: QboJson;
    const bookingIds: string[] = [];
    const customerIds = new Set<string>();
    const qboPaymentIds: string[] = [];
    const qboInvoiceIds: string[] = [];

    async function newStaffBooking(offset: number, email: string): Promise<string> {
      const { data, error } = await staff.rpc("staff_create_booking", {
        p_size: "15yd",
        p_delivery_date: farDate(offset),
        p_delivery_address: `1 ${MARKER} St, Columbus, OH 43004`,
        p_contact_name: `QBO Pay Test ${MARKER}`,
        p_contact_email: email,
        p_contact_phone: "6145550100",
      });
      expect(error).toBeNull();
      const id = data as string;
      bookingIds.push(id);
      const { data: b } = await service.from("bookings").select("customer_id").eq("id", id).single();
      customerIds.add(b!.customer_id as string);
      return id;
    }

    async function qboInvoice(id: string) {
      return (
        await qbo<{ Invoice: { Id: string; Balance: number; TotalAmt: number; EmailStatus: string; LinkedTxn?: Array<{ TxnId: string; TxnType: string }> } }>(
          `invoice/${id}?minorversion=75`,
        )
      ).Invoice;
    }

    /** Stand-in for the customer paying the hosted link. */
    async function simulateOnlinePayment(invoiceId: string, amount: number): Promise<string> {
      const inv = await qbo<{ Invoice: { CustomerRef: { value: string } } }>(`invoice/${invoiceId}`);
      const p = await qbo<{ Payment: { Id: string } }>("payment", {
        method: "POST",
        body: JSON.stringify({
          CustomerRef: inv.Invoice.CustomerRef,
          TotalAmt: amount,
          PrivateNote: `${MARKER} simulated Pay Now`,
          Line: [{ Amount: amount, LinkedTxn: [{ TxnId: invoiceId, TxnType: "Invoice" }] }],
        }),
      });
      qboPaymentIds.push(p.Payment.Id);
      return p.Payment.Id;
    }

    beforeAll(async () => {
      if ((process.env.QUICKBOOKS_ENVIRONMENT ?? "sandbox") === "production") {
        throw new Error("Refusing to run: QUICKBOOKS_ENVIRONMENT=production.");
      }
      if (LIVE_SEND && !SEND_TO) {
        throw new Error("CL_VERIFY_QBO_SEND_LIVE=1 requires CL_QBO_TEST_SEND_TO.");
      }
      service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
      staff = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await staff.auth.signInWithPassword({ email: staffEmail!, password: staffPassword! });
      if (error) throw new Error(`staff sign-in failed: ${error.message}`);
      ({ quickbooksJson: qbo } = (await import("./client")) as unknown as { quickbooksJson: QboJson });
    });

    afterAll(async () => {
      for (const id of qboPaymentIds) {
        try {
          const cur = await qbo<{ Payment: { SyncToken: string } }>(`payment/${id}`);
          await qbo("payment?operation=delete", {
            method: "POST",
            body: JSON.stringify({ Id: id, SyncToken: cur.Payment.SyncToken }),
          });
        } catch (e) {
          console.error(`[cleanup] QBO payment ${id}:`, (e as Error).message);
        }
      }
      for (const id of qboInvoiceIds) {
        try {
          const cur = await qbo<{ Invoice: { SyncToken: string; TotalAmt: number } }>(`invoice/${id}`);
          if (Number(cur.Invoice.TotalAmt) > 0) {
            await qbo("invoice?operation=void", {
              method: "POST",
              body: JSON.stringify({ Id: id, SyncToken: cur.Invoice.SyncToken }),
            });
          }
        } catch (e) {
          console.error(`[cleanup] QBO invoice ${id}:`, (e as Error).message);
        }
      }
      for (const id of bookingIds) {
        const { data: jobs } = await service.from("jobs").select("id").eq("booking_id", id);
        for (const step of [
          () => service.from("status_log").delete().in("entity_id", [id, ...(jobs ?? []).map((j) => j.id as string)]),
          () => service.from("invoices").delete().eq("booking_id", id),
          () => service.from("jobs").delete().eq("booking_id", id),
          () => service.from("bookings").delete().eq("id", id),
        ]) {
          try {
            const { error } = await step();
            if (error) console.error(`[cleanup] booking ${id}:`, error.message);
          } catch (e) {
            console.error(`[cleanup] booking ${id}:`, (e as Error).message);
          }
        }
      }
      for (const id of Array.from(customerIds)) {
        try {
          await service.from("customers").delete().eq("id", id);
        } catch (e) {
          console.error(`[cleanup] customer ${id}:`, (e as Error).message);
        }
      }
    });

    // Reported, not asserted: Intuit sandbox companies come back with
    // ETransactionPaymentEnabled=false / ETransactionEnabledStatus
    // "NotApplicable" and a developer.intuit.com/comingSoon placeholder
    // InvoiceLink (observed 2026-09-24), so the hosted Pay Now page itself can
    // only be exercised against the production company. Everything else here
    // (invoice flags stored, Balance polling, partial/void/double-pay) is real.
    it("reports whether the company accepts online invoice payments", async () => {
      const prefs = await qbo<{ Preferences: { SalesFormsPrefs: { ETransactionPaymentEnabled?: boolean } } }>(
        "preferences",
      );
      const enabled = prefs.Preferences.SalesFormsPrefs.ETransactionPaymentEnabled;
      const methods = await qbo<{ QueryResponse: { PaymentMethod?: Array<{ Id: string; Name: string }> } }>(
        `query?query=${encodeURIComponent("select * from PaymentMethod")}`,
      );
      console.log(
        "ETransactionPaymentEnabled =", enabled,
        "| PaymentMethods:", JSON.stringify((methods.QueryResponse.PaymentMethod ?? []).map((m) => `${m.Id}:${m.Name}`)),
      );
      expect(typeof enabled).toBe("boolean");
      if (!enabled) {
        console.warn(
          "ETransactionPaymentEnabled=false: QBO invoices from this company will NOT offer Pay Now. " +
            "Expected in sandbox; in production it must be true before staff use pay-link invoices.",
        );
      }
    });

    it("cash/check: record_manual_payment -> QBO invoice + Payment w/ Check method + check #, balance 0", async () => {
      const bookingId = await newStaffBooking(0, SAFE_EMAIL);
      const { error } = await staff.rpc("record_manual_payment", {
        p_booking_id: bookingId,
        p_method: "check",
        p_reference: "2231",
        p_note: MARKER,
      });
      expect(error).toBeNull();

      const { syncInvoiceForBooking } = await import("./invoices");
      const qbInvoiceId = await syncInvoiceForBooking(bookingId);
      expect(qbInvoiceId).toBeTruthy();
      qboInvoiceIds.push(qbInvoiceId!);

      const { data: row } = await service
        .from("invoices")
        .select("status, payment_method, sync_status, quickbooks_invoice_id, qb_payment_id, failure_reason")
        .eq("booking_id", bookingId)
        .single();
      if (row?.qb_payment_id) qboPaymentIds.push(row.qb_payment_id as string);
      const inv = await qboInvoice(qbInvoiceId!);
      const pay = (
        await qbo<{ Payment: { TotalAmt: number; PaymentRefNum?: string; PaymentMethodRef?: { value: string; name?: string } } }>(
          `payment/${row!.qb_payment_id}`,
        )
      ).Payment;
      console.log("db invoice row:", JSON.stringify(row));
      console.log("QBO invoice:", JSON.stringify({ Id: inv.Id, TotalAmt: inv.TotalAmt, Balance: inv.Balance, LinkedTxn: inv.LinkedTxn }));
      console.log("QBO payment:", JSON.stringify(pay));

      expect(row).toMatchObject({ status: "paid", payment_method: "check", sync_status: "synced", failure_reason: null });
      expect(Number(inv.Balance)).toBe(0);
      expect(pay.PaymentRefNum).toBe("2231");
      expect(pay.PaymentMethodRef?.value).toBeTruthy();
    });

    it("pay link: invoice created with InvoiceLink; partial payment stays unpaid; full payment detected", async () => {
      const to = LIVE_SEND ? SEND_TO! : SAFE_EMAIL;
      const bookingId = await newStaffBooking(20, to);
      const { createOrResendBookingInvoice, reconcileInvoicePayments } = await import("./invoice-payments");

      const r = await createOrResendBookingInvoice({
        bookingId,
        sendTo: to,
        existingQbInvoiceId: null,
        send: LIVE_SEND,
      });
      qboInvoiceIds.push(r.qbInvoiceId);
      console.log("createOrResend:", JSON.stringify(r));
      expect(r.invoiceLink).toMatch(/^https:\/\//);
      if (LIVE_SEND) {
        expect(r.sent).toBe(true);
        expect((await qboInvoice(r.qbInvoiceId)).EmailStatus).toBe("EmailSent");
      } else {
        expect(r.sent).toBe(false);
        expect(r.sendError).toBeNull();
      }

      const { error: issueErr } = await staff.rpc("record_invoice_issued", {
        p_booking_id: bookingId,
        p_qb_invoice_id: r.qbInvoiceId,
        p_invoice_link: r.invoiceLink,
        p_sent_to: r.sent ? to : null,
      });
      expect(issueErr).toBeNull();

      const inv = await qboInvoice(r.qbInvoiceId);
      const total = Number(inv.TotalAmt);

      await simulateOnlinePayment(r.qbInvoiceId, 50);
      const partial = await reconcileInvoicePayments([bookingId]);
      const { data: afterPartial } = await service
        .from("invoices")
        .select("status, qb_balance")
        .eq("booking_id", bookingId)
        .single();
      console.log("after $50 partial:", JSON.stringify(partial), JSON.stringify(afterPartial));
      expect(partial.partial).toEqual([bookingId]);
      expect(partial.paid).toEqual([]);
      expect(Number(afterPartial!.qb_balance)).toBeCloseTo(total - 50, 2);

      const lastPaymentId = await simulateOnlinePayment(r.qbInvoiceId, Math.round((total - 50) * 100) / 100);
      const full = await reconcileInvoicePayments([bookingId]);
      const { data: b } = await service.from("bookings").select("payment_status").eq("id", bookingId).single();
      const { data: row } = await service
        .from("invoices")
        .select("status, payment_method, qb_payment_id, recorded_by, qb_balance")
        .eq("booking_id", bookingId)
        .single();
      console.log("after remaining balance:", JSON.stringify(full), JSON.stringify(b), JSON.stringify(row));
      expect(full.paid).toEqual([bookingId]);
      expect(b!.payment_status).toBe("paid");
      expect(row).toMatchObject({ status: "paid", payment_method: "qbo_invoice", recorded_by: null });
      expect([lastPaymentId, qboPaymentIds.at(-2)]).toContain(row!.qb_payment_id);

      const again = await reconcileInvoicePayments([bookingId]);
      expect(again.checked).toBe(0); // no longer outstanding
    });

    it("cash recorded after the link was sent posts against THAT invoice; online payment after that flags double-pay", async () => {
      const bookingId = await newStaffBooking(40, SAFE_EMAIL);
      const { createOrResendBookingInvoice } = await import("./invoice-payments");
      const r = await createOrResendBookingInvoice({ bookingId, sendTo: SAFE_EMAIL, existingQbInvoiceId: null, send: false });
      qboInvoiceIds.push(r.qbInvoiceId);
      await staff.rpc("record_invoice_issued", {
        p_booking_id: bookingId, p_qb_invoice_id: r.qbInvoiceId, p_invoice_link: r.invoiceLink, p_sent_to: null,
      });

      // Customer paid online, THEN staff (not knowing) records cash.
      const total = Number((await qboInvoice(r.qbInvoiceId)).TotalAmt);
      await simulateOnlinePayment(r.qbInvoiceId, total);
      const { error } = await staff.rpc("record_manual_payment", { p_booking_id: bookingId, p_method: "cash" });
      expect(error).toBeNull();

      const { syncInvoiceForBooking } = await import("./invoices");
      const res = await syncInvoiceForBooking(bookingId);
      const { data: row } = await service
        .from("invoices")
        .select("quickbooks_invoice_id, qb_payment_id, sync_status, failure_reason")
        .eq("booking_id", bookingId)
        .single();
      const inv = await qboInvoice(r.qbInvoiceId);
      console.log("double-pay case:", res, JSON.stringify(row), "QBO LinkedTxn:", JSON.stringify(inv.LinkedTxn));
      expect(res).toBeNull();
      expect(row!.sync_status).toBe("error");
      expect(row!.failure_reason).toMatch(/possible double payment/);
      expect(row!.qb_payment_id).toBeNull(); // no second QBO payment posted
      expect((inv.LinkedTxn ?? []).filter((t) => t.TxnType === "Payment")).toHaveLength(1);
    });

    it("voided QBO invoice is reported as a problem, never as paid", async () => {
      const bookingId = await newStaffBooking(60, SAFE_EMAIL);
      const { createOrResendBookingInvoice, reconcileInvoicePayments } = await import("./invoice-payments");
      const r = await createOrResendBookingInvoice({ bookingId, sendTo: SAFE_EMAIL, existingQbInvoiceId: null, send: false });
      qboInvoiceIds.push(r.qbInvoiceId);
      await staff.rpc("record_invoice_issued", {
        p_booking_id: bookingId, p_qb_invoice_id: r.qbInvoiceId, p_invoice_link: r.invoiceLink, p_sent_to: null,
      });
      const cur = await qbo<{ Invoice: { SyncToken: string } }>(`invoice/${r.qbInvoiceId}`);
      await qbo("invoice?operation=void", {
        method: "POST",
        body: JSON.stringify({ Id: r.qbInvoiceId, SyncToken: cur.Invoice.SyncToken }),
      });
      const res = await reconcileInvoicePayments([bookingId]);
      const { data: b } = await service.from("bookings").select("payment_status").eq("id", bookingId).single();
      console.log("voided:", JSON.stringify(res), JSON.stringify(b));
      expect(res.paid).toEqual([]);
      expect(res.problems[0]?.reason).toMatch(/voided/);
      expect(b!.payment_status).toBe("unpaid");
    });
  },
);
