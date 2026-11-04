import { requireStaff } from "@/lib/auth/requireStaff";
import { getPricingConfig } from "@/lib/bookings/pricing";
import {
  SizePricingRow,
  GlobalSettingsForm,
} from "./_components/PricingForms";
import { QuickBooksPanel } from "./_components/QuickBooksPanel";
import { PayLinkSettingsPanel } from "./_components/PayLinkSettings";
import {
  envWarnings,
  getAlertRecipientStatus,
  getLiveCounts,
  getPayLinkSettings,
  listAlertCandidates,
} from "@/lib/pay-links/settings";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings · Crazy Larry's" };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { qb?: string };
}) {
  const staff = await requireStaff();
  const canEdit = staff.role === "owner";
  const config = await getPricingConfig();
  const payLinks = await getPayLinkSettings();
  const [live, recipient, candidates] = await Promise.all([
    getLiveCounts(),
    getAlertRecipientStatus(payLinks.staff_alert_user_id),
    canEdit ? listAlertCandidates() : Promise.resolve([]),
  ]);

  return (
    <div className="flex max-w-3xl flex-col gap-4 p-4 md:p-7">
      <div>
        <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
          Pricing
        </h1>
        <p className="text-[12px] text-ink-2">
          {canEdit
            ? "Enter Larry's real rates. Online booking stays closed for a size until it has a price above $0 and is marked active."
            : "Read-only — only the owner can change rates."}
        </p>
      </div>

      {!config.bookingReady && (
        <p className="border-l-4 border-orange bg-orange-tint px-3 py-2 text-[13px] font-semibold text-orange-tint-ink">
          Online booking is currently blocked: pricing is incomplete.
        </p>
      )}

      <section className="border-2 border-line-strong bg-surface">
        <div className="border-b-2 border-line-strong px-4 py-3 text-[15px] font-extrabold">
          Per-size flat rate
        </div>
        {config.sizes.map((z) => (
          <SizePricingRow key={z.size} {...z} canEdit={canEdit} />
        ))}
      </section>

      <section className="border-2 border-line-strong bg-surface">
        <div className="border-b-2 border-line-strong px-4 py-3 text-[15px] font-extrabold">
          Global rates &amp; tax
        </div>
        <GlobalSettingsForm config={config} canEdit={canEdit} />
      </section>

      <PayLinkSettingsPanel
        settings={payLinks}
        canEdit={canEdit}
        candidates={candidates}
        recipient={recipient}
        live={live}
        warnings={envWarnings()}
      />

      {canEdit && <QuickBooksPanel notice={searchParams.qb} />}
    </div>
  );
}
