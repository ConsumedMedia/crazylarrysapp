"use client";

import { useEffect } from "react";

/**
 * Hosts DocuSign's embedded signing session (a one-time recipient-view URL
 * minted server-side for this customer's own envelope). There is no
 * self-attest checkbox any more: when signing ends, DocuSign redirects this
 * iframe to /book/agreement/return, which messages the wizard, which asks the
 * SERVER to confirm completion with DocuSign.
 */
export function AgreementModal({
  open,
  onClose,
  size,
  signingUrl,
}: {
  open: boolean;
  onClose: () => void;
  size: string;
  signingUrl: string | null;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(6,8,11,0.72)] p-3 sm:p-8">
      <div className="flex max-h-full w-full max-w-4xl flex-col border-2 border-line-strong bg-surface shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b-2 border-line-strong px-4 py-3">
          <div className="min-w-0">
            <div className="text-[15px] font-extrabold tracking-[-0.01em]">
              Rental agreement · {size.replace("yd", " yard")}
            </div>
            <div className="mt-0.5 text-[11px] text-ink-3">
              Secure signing by DocuSign. This window closes by itself when you finish.
            </div>
          </div>
          <button
            onClick={onClose}
            className="border-2 border-line px-2.5 py-1 text-[12px] font-extrabold hover:border-ink"
          >
            Close
          </button>
        </div>

        <div className="flex-1 bg-bg">
          {signingUrl ? (
            <iframe
              src={signingUrl}
              title="Rental agreement signing"
              className="h-[72vh] w-full border-0"
            />
          ) : (
            <div className="flex h-[40vh] items-center justify-center p-6 text-center text-[13px] text-ink-2">
              Opening DocuSign…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
