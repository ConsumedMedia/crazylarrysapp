import { getPricingConfig } from "@/lib/bookings/pricing";
import { quickBooksConfigured } from "@/lib/quickbooks/config";
import { BookingWizard } from "./_components/BookingWizard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Book a dumpster · Crazy Larry's" };

export default async function BookPage() {
  const pricing = await getPricingConfig();
  const docusignUrl = process.env.NEXT_PUBLIC_DOCUSIGN_URL ?? null;

  // Card data is POSTed from the browser straight to this Intuit endpoint;
  // the host is environment-dependent and is not a secret.
  const qbEnv = process.env.QUICKBOOKS_ENVIRONMENT ?? "sandbox";
  const tokenizeUrl =
    qbEnv === "production"
      ? "https://api.intuit.com/quickbooks/v4/payments/tokens"
      : "https://sandbox.api.intuit.com/quickbooks/v4/payments/tokens";
  const paymentsReady = quickBooksConfigured();

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-8 sm:py-10">
      <div className="mb-2 flex items-center gap-2.5">
        <div className="grid h-8 w-8 place-items-center bg-pink text-[13px] font-black text-white">
          CL
        </div>
        <div className="text-[11px] font-extrabold uppercase leading-tight tracking-[0.12em]">
          Crazy&nbsp;Larry&apos;s
          <br />
          <span className="text-[9px] tracking-[0.18em] text-ink-3">
            Dumpster Rental · Columbus
          </span>
        </div>
      </div>
      <BookingWizard
        pricing={pricing}
        docusignUrl={docusignUrl}
        tokenizeUrl={tokenizeUrl}
        paymentsReady={paymentsReady}
      />
    </main>
  );
}
