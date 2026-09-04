export function StatCard({
  label,
  value,
  href,
  tone = "default",
}: {
  label: string;
  value: number | string;
  href?: string;
  tone?: "default" | "orange" | "pink";
}) {
  const valueCls =
    tone === "orange"
      ? "text-orange"
      : tone === "pink"
        ? "text-pink"
        : "text-ink";
  const body = (
    <div className="flex flex-col gap-1 border-2 border-line-strong bg-surface p-4">
      <span className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
        {label}
      </span>
      <span className={`cl-nums text-[30px] font-black leading-none tracking-[-0.03em] ${valueCls}`}>
        {value}
      </span>
    </div>
  );
  if (!href) return body;
  return (
    <a href={href} className="block transition hover:-translate-y-[1px]">
      {body}
    </a>
  );
}
