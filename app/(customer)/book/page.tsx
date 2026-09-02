import { getPricingConfig } from "@/lib/bookings/pricing";
import { BookingWizard } from "./_components/BookingWizard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Book a dumpster · Crazy Larry's" };

export default async function BookPage() {
  const pricing = await getPricingConfig();
  const docusignUrl = process.env.NEXT_PUBLIC_DOCUSIGN_URL ?? null;

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
      <BookingWizard pricing={pricing} docusignUrl={docusignUrl} />
    </main>
  );
}
