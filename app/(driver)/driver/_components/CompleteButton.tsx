"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { completeJobAction, type CompleteState } from "../actions";

const UPLOAD_TIMEOUT_MS = 12_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Uploads directly to Storage from the browser (respects the job-photos RLS
 * policy — the driver's own session, not a server round-trip for the binary).
 * Bounded by UPLOAD_TIMEOUT_MS so a dead-zone stall doesn't hang the driver
 * — on timeout or any error this returns null and the caller proceeds with
 * completion anyway. See lib/driver/mutations.ts::completeMyJob for why
 * completion is never gated on this succeeding.
 */
async function uploadPhoto(jobId: string, file: File): Promise<string | null> {
  try {
    const supabase = createClient();
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${jobId}/${crypto.randomUUID()}.${ext}`;
    const { error } = await withTimeout(
      supabase.storage
        .from("job-photos")
        .upload(path, file, { contentType: file.type || "image/jpeg" }),
      UPLOAD_TIMEOUT_MS,
    );
    if (error) return null;
    return path;
  } catch {
    return null;
  }
}

export function CompleteButton({
  jobId,
  jobType,
}: {
  jobId: string;
  jobType: "delivery" | "pickup";
}) {
  const photoRequired = jobType === "delivery";
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<CompleteState>({ ok: false });

  function pickPhoto() {
    fileInputRef.current?.click();
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setPreviewUrl(f ? URL.createObjectURL(f) : null);
  }

  async function markComplete() {
    setPending(true);
    setState({ ok: false });

    let photoStoragePath: string | null = null;
    let photoFailed = false;
    if (file) {
      photoStoragePath = await uploadPhoto(jobId, file);
      photoFailed = !photoStoragePath;
    }

    const fd = new FormData();
    fd.set("job_id", jobId);
    fd.set("photo_storage_path", photoStoragePath ?? "");
    fd.set("photo_failed", photoFailed ? "1" : "0");

    const result = await completeJobAction(state, fd);
    setPending(false);
    setState(result);
    if (result.ok) router.refresh();
  }

  const canSubmit = !pending && (!photoRequired || !!file);

  return (
    <div className="flex flex-col gap-3">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={onFileChange}
      />

      {previewUrl ? (
        <div className="flex items-center gap-3 border-2 border-line-strong bg-surface p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt="Placement photo preview"
            className="h-14 w-14 flex-none object-cover"
          />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-bold">Photo ready</div>
            <div className="text-[12px] text-ink-2">Uploads when you mark complete.</div>
          </div>
          <button
            type="button"
            onClick={pickPhoto}
            className="flex-none border-2 border-line px-2.5 py-1.5 text-[11px] font-extrabold hover:border-ink"
          >
            Retake
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={pickPhoto}
          className="flex items-center gap-3 border-2 border-dashed border-line-strong bg-surface-2 p-3.5 text-left"
        >
          <span className="grid h-11 w-11 flex-none place-items-center bg-ink text-surface">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.1"
              strokeLinecap="round"
            >
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-extrabold">Take a placement photo</div>
            <div className="text-[13px] leading-snug text-ink-2">
              {photoRequired
                ? "Required on drops. Goes to the customer automatically."
                : "Optional on pickups."}
            </div>
          </div>
        </button>
      )}

      <button
        type="button"
        onClick={markComplete}
        disabled={!canSubmit}
        className="flex w-full items-center justify-between bg-teal px-4 py-5 text-left text-[16px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-50"
      >
        {pending ? "Marking…" : jobType === "delivery" ? "Mark delivered" : "Mark picked up"}
        <span>✓</span>
      </button>

      {photoRequired && !file && (
        <p className="text-[12px] text-ink-3">Take the placement photo to mark this delivered.</p>
      )}
      {state.error && (
        <p className="border-l-4 border-orange bg-orange-tint px-3 py-2 text-[13px] font-semibold text-orange-tint-ink">
          {state.error}
        </p>
      )}
      {state.ok && state.photoWarning && (
        <p className="border-l-4 border-orange bg-orange-tint px-3 py-2 text-[13px] font-semibold text-orange-tint-ink">
          {state.photoWarning}
        </p>
      )}
      {state.ok && !state.photoWarning && (
        <p className="border-l-4 border-teal bg-teal-tint px-3 py-2 text-[13px] font-semibold text-teal-tint-ink">
          Done.
        </p>
      )}
    </div>
  );
}
