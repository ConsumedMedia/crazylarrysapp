export function RevenueToday({ amount }: { amount: number }) {
  return (
    <section className="border-2 border-line-strong bg-surface p-4">
      <div className="mb-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
        Collected today · owner
      </div>
      <div className="cl-nums text-[30px] font-black leading-none tracking-[-0.03em] text-teal">
        ${amount.toFixed(2)}
      </div>
    </section>
  );
}
