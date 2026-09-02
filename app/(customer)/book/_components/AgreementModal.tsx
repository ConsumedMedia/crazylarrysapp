"use client";

import { useEffect } from "react";

export function AgreementModal({
  open,
  onClose,
  onAcknowledge,
  acknowledged,
  size,
  docusignUrl,
}: {
  open: boolean;
  onClose: () => void;
  onAcknowledge: (v: boolean) => void;
  acknowledged: boolean;
  size: string;
  docusignUrl: string | null;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(6,8,11,0.72)] p-3 sm:p-12"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-3xl flex-col border-2 border-line-strong bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b-2 border-line-strong px-4 py-3">
          <div className="min-w-0">
            <div className="text-[15px] font-extrabold tracking-[-0.01em]">
              Rental agreement · {size.replace("yd", " yard")}
            </div>
            <div className="mt-0.5 text-[11px] text-ink-3">
              Hosted by DocuSign
            </div>
          </div>
          <button
            onClick={onClose}
            className="border-2 border-line px-2.5 py-1 text-[12px] font-extrabold hover:border-ink"
          >
            Close
          </button>
        </div>

        <div className="min-h-[320px] flex-1 bg-bg">
          {docusignUrl ? (
            <iframe
              src={docusignUrl}
              title="Rental agreement"
              className="h-[52vh] w-full border-0"
            />
          ) : (
            <div className="flex h-[52vh] items-center justify-center p-6 text-center text-[13px] text-ink-2">
              The rental agreement link isn&apos;t configured yet. Larry&apos;s
              office will send the agreement separately after you book.
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t-2 border-line-strong p-4">
          <label className="flex items-start gap-2.5 text-[13px]">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => onAcknowledge(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I&apos;ve read and completed the rental agreement in DocuSign.
              <span className="block text-[11px] text-ink-3">
                Larry&apos;s office confirms the signature against DocuSign
                before the can is dispatched.
              </span>
            </span>
          </label>
          <button
            onClick={onClose}
            className="self-start bg-teal px-4 py-2 text-left text-[13px] font-extrabold text-white hover:bg-teal-700"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
