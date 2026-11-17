import { ReturnBridge } from "./ReturnBridge";

export const dynamic = "force-dynamic";
export const metadata = { title: "Returning to checkout · Crazy Larry's" };

/**
 * DocuSign's post-signing redirect target (?session=<id>&event=<...>).
 *
 * Deliberately renders almost nothing: inside the checkout modal's iframe it
 * only hands control back to the parent wizard; loaded full-page (phones) it
 * sends the customer back to /book. It never renders the booking app itself —
 * a normal page here would nest the whole wizard inside its own modal.
 *
 * Nothing on this page is trusted: `event=signing_complete` is only a trigger
 * for the server to ask DocuSign directly (verifyAgreementAction). Anyone can
 * visit this URL; doing so unlocks nothing.
 */
export default function AgreementReturnPage({
  searchParams,
}: {
  searchParams: { session?: string; event?: string };
}) {
  return (
    <main className="flex min-h-[40vh] items-center justify-center p-6 text-center text-[14px] text-ink-2">
      <ReturnBridge sessionId={searchParams.session ?? ""} event={searchParams.event ?? ""} />
    </main>
  );
}
