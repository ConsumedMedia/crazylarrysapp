import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in · Crazy Larry's Operations" };

export default function LoginPage({
  searchParams,
}: {
  searchParams: { denied?: string };
}) {
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-4 text-ink">
      <div className="w-full max-w-sm border-2 border-line-strong bg-surface">
        <div className="flex items-center gap-2.5 border-b-2 border-line-strong px-5 py-4">
          <div className="grid h-8 w-8 place-items-center bg-pink text-[13px] font-black text-white">
            CL
          </div>
          <div className="text-[11px] font-extrabold uppercase leading-tight tracking-[0.12em]">
            Crazy&nbsp;Larry&apos;s
            <br />
            <span className="text-[9px] tracking-[0.18em] text-ink-3">
              Operations
            </span>
          </div>
        </div>
        <div className="p-5">
          {searchParams.denied && (
            <p className="mb-4 border-2 border-orange bg-orange-tint px-3 py-2 text-[12px] font-semibold text-orange-tint-ink">
              That account doesn&apos;t have operations access.
            </p>
          )}
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
