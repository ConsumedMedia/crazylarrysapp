import { agreementBanner, type AgreementStatus } from "@/lib/docusign/mode-shared";

const TONE = {
  neutral: "border-line bg-tint text-ink-2",
  on: "border-teal bg-teal-tint text-teal-tint-ink",
  warn: "border-orange bg-orange-tint text-orange-tint-ink",
} as const;

/**
 * Top of /settings: which rental agreement /book is using right now, and why
 * when the two keys disagree (Settings say DocuSign but this deployment isn't
 * set up, or the setting can't be read).
 */
export function AgreementModeBanner({ status }: { status: AgreementStatus }) {
  const b = agreementBanner(status);
  return (
    <p
      role={b.tone === "warn" ? "alert" : "status"}
      data-testid="agreement-mode-banner"
      data-tone={b.tone}
      className={`border-l-4 px-3 py-2 text-[13px] font-semibold ${TONE[b.tone]}`}
    >
      {b.text}{" "}
      <a href="#agreement" className="underline">
        Rental agreement settings
      </a>
    </p>
  );
}
