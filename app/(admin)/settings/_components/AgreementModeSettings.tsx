"use client";

import { useFormState, useFormStatus } from "react-dom";
import { capabilityGap, type AgreementStatus } from "@/lib/docusign/mode-shared";
import {
  checkDocusignAction,
  saveAgreementModeAction,
  type PreflightState,
  type SettingsState,
} from "../actions";

const init: SettingsState = { ok: false };
const preflightInit: PreflightState = { ran: false };

function Submit({ idle, busy, tone = "teal" }: { idle: string; busy: string; tone?: "teal" | "outline" }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={
        tone === "teal"
          ? "self-start bg-teal px-3.5 py-2 text-left text-[12px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-60"
          : "self-start border-2 border-ink px-3.5 py-2 text-left text-[12px] font-extrabold hover:bg-tint disabled:opacity-60"
      }
    >
      {pending ? busy : idle}
    </button>
  );
}

const MODE_LABEL = { attest: "PowerForm and checkbox", docusign: "DocuSign" } as const;

/**
 * Settings → Rental agreement. Owners pick the mode; staff see it read-only.
 * Every staff member can run "Check DocuSign". The mode is one of two keys:
 * DocuSign is used only where the deployment also has CL_DOCUSIGN_ENABLED=1
 * and every DOCUSIGN_* variable (lib/docusign/mode-shared).
 */
export function AgreementModePanel({ status, canEdit }: { status: AgreementStatus; canEdit: boolean }) {
  const [state, action] = useFormState(saveAgreementModeAction, init);
  const [check, runCheck] = useFormState(checkDocusignAction, preflightInit);
  const on = status.effective === "docusign";

  return (
    <section id="agreement" className="border-2 border-line-strong bg-surface" data-testid="agreement-mode-panel">
      <div className="flex flex-wrap items-center gap-2 border-b-2 border-line-strong px-4 py-3">
        <span className="text-[15px] font-extrabold">Rental agreement (online)</span>
        <span
          className={`px-2 py-0.5 text-[11px] font-extrabold uppercase ${
            on ? "bg-teal-tint text-teal-tint-ink" : "bg-tint text-ink-2"
          }`}
        >
          {MODE_LABEL[status.effective]}
        </span>
      </div>

      <div className="flex flex-col gap-3 p-4">
        <p className="text-[13px] text-ink-2">
          How customers sign Larry&apos;s rental agreement on /book. DocuSign is used only when it&apos;s chosen here
          <em> and</em> this deployment is set up for it. Otherwise /book uses the PowerForm and checkbox. Preview and
          Production share this setting.
        </p>

        <p className="text-[12px] font-semibold" data-testid="agreement-capability">
          This deployment:{" "}
          {status.capability.ok ? (
            <span className="text-teal-tint-ink">set up for DocuSign.</span>
          ) : (
            <span className="text-ink-2">not set up for DocuSign ({capabilityGap(status.capability)}).</span>
          )}
        </p>

        {status.setting === null ? (
          <p className="border-l-4 border-orange bg-orange-tint px-3 py-2 text-[12px] font-semibold text-orange-tint-ink">
            The setting couldn&apos;t be read just now, so /book uses the PowerForm and checkbox.
          </p>
        ) : canEdit ? (
          <form action={action} className="flex flex-col gap-2">
            {(["attest", "docusign"] as const).map((m) => (
              <label key={m} className="flex items-center gap-2 text-[13px] font-semibold">
                <input type="radio" name="agreement_mode" value={m} defaultChecked={status.setting === m} />
                {MODE_LABEL[m]}
              </label>
            ))}
            {state.error && <p className="text-[12px] font-semibold text-orange-tint-ink">{state.error}</p>}
            {state.ok && state.message && <p className="text-[12px] font-semibold text-teal-tint-ink">{state.message}</p>}
            <Submit idle="Save rental agreement" busy="…" />
          </form>
        ) : (
          <p className="text-[13px] font-semibold">
            Set to {MODE_LABEL[status.setting]}.{" "}
            <span className="font-normal text-ink-3">Read-only — only an owner can change it.</span>
          </p>
        )}

        <form action={runCheck} className="flex flex-col gap-2 border-t-2 border-line pt-3">
          <p className="text-[12px] text-ink-2">
            Check DocuSign signs in and reads the agreement template. It creates no envelope and sends nothing.
          </p>
          <Submit idle="Check DocuSign" busy="Checking…" tone="outline" />
          {check.error && <p className="text-[12px] font-semibold text-orange-tint-ink">{check.error}</p>}
          {check.result && (
            <div data-testid="docusign-preflight">
              <p className={`text-[12px] font-extrabold ${check.result.ok ? "text-teal-tint-ink" : "text-orange-tint-ink"}`}>
                {check.result.ok ? "Ready" : "Not ready"}
                {check.result.environment ? ` · ${check.result.environment}` : ""}
              </p>
              <ul className="mt-1 flex flex-col gap-1">
                {check.result.steps.map((s) => (
                  <li key={s.key} className="text-[12px]">
                    <span className={`font-extrabold ${s.ok ? "text-teal-tint-ink" : "text-orange-tint-ink"}`}>
                      {s.ok ? "✓" : "✗"} {s.label}
                    </span>{" "}
                    <span className="text-ink-2">{s.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </form>
      </div>
    </section>
  );
}
