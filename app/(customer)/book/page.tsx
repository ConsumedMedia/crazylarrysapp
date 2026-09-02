import { AvailabilityCalendar } from "./_components/AvailabilityCalendar";

export const metadata = { title: "Check availability · Crazy Larry's Dumpsters" };

export default function BookPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-12">
      <header className="mb-6">
        <h1 className="text-[30px] font-black leading-none tracking-[-0.035em]">
          When do you want it dropped?
        </h1>
        <p className="mt-2 text-[15px] text-ink-2">
          Every size includes five days on site, one ton of weight, delivery and
          haul-away. Availability below is live — it reads straight off the yard.
        </p>
      </header>
      <AvailabilityCalendar />
    </main>
  );
}
