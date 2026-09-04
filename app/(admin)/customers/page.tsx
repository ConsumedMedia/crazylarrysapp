import Link from "next/link";
import { requireStaff } from "@/lib/auth/requireStaff";
import { listCustomers } from "@/lib/customers/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customers · Crazy Larry's" };

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  await requireStaff();
  const q = searchParams.q ?? "";
  const customers = await listCustomers(q || undefined);

  return (
    <div className="flex flex-col gap-4 p-4 md:p-7">
      <div>
        <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
          Customers
        </h1>
        <p className="text-[12px] text-ink-2">{customers.length} shown</p>
      </div>

      <form method="get" className="flex gap-2">
        <input
          type="text"
          name="q"
          defaultValue={q}
          placeholder="Search name, email, phone, or company"
          className="w-full max-w-md border-2 border-line bg-bg px-3 py-2.5 text-[14px] text-ink"
        />
        <button
          type="submit"
          className="bg-teal px-4 py-2.5 text-[13px] font-extrabold text-white hover:bg-teal-700"
        >
          Search
        </button>
        {q && (
          <Link
            href="/customers"
            className="border-2 border-line px-4 py-2.5 text-[13px] font-extrabold hover:border-ink"
          >
            Clear
          </Link>
        )}
      </form>

      <section className="border-2 border-line-strong bg-surface">
        {customers.length === 0 ? (
          <p className="p-6 text-center text-[13px] text-ink-2">
            {q ? `No customers match "${q}".` : "No customers yet."}
          </p>
        ) : (
          <ul className="flex flex-col">
            {customers.map((c) => (
              <li key={c.id} className="border-b border-line last:border-b-0">
                <Link
                  href={`/customers/${c.id}`}
                  className="flex items-center gap-3 px-4 py-3 text-[13px] hover:bg-bg"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-extrabold">
                      {c.full_name}
                      {c.company_name && (
                        <span className="font-normal text-ink-2"> · {c.company_name}</span>
                      )}
                    </div>
                    <div className="truncate text-ink-2">
                      {[c.email, c.phone].filter(Boolean).join(" · ") || "No contact info"}
                    </div>
                  </div>
                  {c.is_registered && (
                    <span className="flex-none border-2 border-line px-1.5 py-0.5 text-[10px] font-extrabold uppercase text-ink-2">
                      Account
                    </span>
                  )}
                  <span className="cl-nums flex-none font-extrabold">
                    {c.booking_count} {c.booking_count === 1 ? "booking" : "bookings"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
