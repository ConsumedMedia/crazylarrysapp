import type { Metadata } from "next";
import { headers } from "next/headers";
import { lookupPayLink } from "@/lib/pay-links/pay";
import { clientIpFrom, clientKeyFor } from "@/lib/pay-links/token";
import { quickBooksConfigured } from "@/lib/quickbooks/config";
import { PayLinkForm } from "./PayLinkForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Pay for your dumpster · Crazy Larry's",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const YARD_PHONE = process.env.CL_YARD_PHONE || "the yard";

/** yyyy-mm-dd booking dates are calendar days: format them in UTC. */
function fmt(d: string) {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
const money = (n: number) => `$${n.toFixed(2)}`;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:px-8 sm:py-10">
      <div className="mb-6 flex items-center gap-2.5">
        <div className="grid h-8 w-8 place-items-center bg-pink text-[13px] font-black text-white">CL</div>
        <div className="text-[11px] font-extrabold uppercase leading-tight tracking-[0.12em]">
          Crazy&nbsp;Larry&apos;s
          <br />
          <span className="text-[9px] tracking-[0.18em] text-ink-3">Dumpster Rental · Columbus</span>
        </div>
      </div>
      {children}
    </main>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Shell>
      <section className="border-2 border-line-strong bg-surface p-5">
        <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em]">{title}</h1>
        <p className="mt-2 text-[14px] text-ink-2">{children}</p>
      </section>
    </Shell>
  );
}

/**
 * Public pay page for a staff phone booking. Reads ONLY what pay_link_lookup
 * returns (first name, size, dates, address, subtotal/tax/total) — never a
 * session, never contact details. The token is the only credential; this
 * route is excluded from the session middleware and served with
 * no-referrer / no-store / noindex (next.config.mjs).
 */
export default async function PayPage({ params }: { params: { token: string } }) {
  const view = await lookupPayLink(params.token, clientKeyFor(clientIpFrom(headers())));

  if (view.state === "paid") {
    return (
      <Notice title="This booking is paid">
        Thanks — your payment went through and your confirmation is on its way. Questions? Call {YARD_PHONE}.
      </Notice>
    );
  }
  if (view.state === "throttled") {
    return <Notice title="Too many attempts">Please try again in a few minutes, or call {YARD_PHONE}.</Notice>;
  }
  if (view.state === "error") {
    return <Notice title="Something went wrong">We couldn&apos;t load this page. Try again in a minute, or call {YARD_PHONE}.</Notice>;
  }
  if (view.state !== "active") {
    return (
      <Notice title="This payment link isn't active">
        If we sent you a newer link, please use that one. Otherwise call {YARD_PHONE} and we&apos;ll help.
      </Notice>
    );
  }

  const qbEnv = process.env.QUICKBOOKS_ENVIRONMENT ?? "sandbox";
  const tokenizeUrl =
    qbEnv === "production"
      ? "https://api.intuit.com/quickbooks/v4/payments/tokens"
      : "https://sandbox.api.intuit.com/quickbooks/v4/payments/tokens";
  const size = view.size.replace("yd", " yard");

  return (
    <Shell>
      <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
        {view.firstName ? `Hi ${view.firstName} — ` : ""}your dumpster is reserved
      </h1>
      <p className="mt-1 text-[13px] text-ink-2">
        Review the rental agreement and pay below. The date, size and price were set on your call with the yard;
        to change them, call {YARD_PHONE}.
      </p>

      <section className="mt-5 border-2 border-line-strong bg-surface">
        <div className="border-b-2 border-line-strong px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.16em]">
          Your booking
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 p-4 text-[14px]">
          <dt className="text-ink-2">Dumpster</dt>
          <dd className="font-bold">{size}</dd>
          <dt className="text-ink-2">Delivery</dt>
          <dd className="font-bold">{fmt(view.deliveryDate)}</dd>
          <dt className="text-ink-2">Pickup</dt>
          <dd className="font-bold">{fmt(view.pickupDate)}</dd>
          <dt className="text-ink-2">Address</dt>
          <dd className="font-bold">{view.deliveryAddress}</dd>
          <dt className="text-ink-2">Rental</dt>
          <dd className="cl-nums">{money(view.subtotal)}</dd>
          <dt className="text-ink-2">Tax</dt>
          <dd className="cl-nums">{money(view.tax)}</dd>
          <dt className="border-t-2 border-line-strong pt-2 font-extrabold">Total</dt>
          <dd className="cl-nums border-t-2 border-line-strong pt-2 text-[18px] font-black">{money(view.total)}</dd>
        </dl>
      </section>

      <div className="mt-4">
        <PayLinkForm
          token={params.token}
          total={view.total}
          size={view.size}
          docusignUrl={process.env.NEXT_PUBLIC_DOCUSIGN_URL ?? null}
          tokenizeUrl={tokenizeUrl}
          paymentsReady={quickBooksConfigured()}
        />
      </div>
    </Shell>
  );
}
