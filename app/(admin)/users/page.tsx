import Link from "next/link";
import { requireOwner } from "@/lib/auth/requireStaff";
import { listStaffUsers } from "@/lib/users/team";
import { listTrucks } from "@/lib/drivers/manage";
import { UserRow, ProtectedCard } from "./_components/UserRows";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users · Crazy Larry's" };

const sectionTitle = "text-[13px] font-extrabold uppercase tracking-[0.12em]";

export default async function UsersPage() {
  const me = await requireOwner();
  const [users, trucks] = await Promise.all([listStaffUsers(), listTrucks()]);

  const protectedUsers = users.filter((u) => u.isProtected);
  const rest = users.filter((u) => !u.isProtected);
  const active = rest.filter((u) => u.status === "active");
  const pending = rest.filter((u) => u.status === "invite_pending");
  const removed = rest.filter((u) => u.status === "removed");

  return (
    <div className="flex max-w-5xl flex-col gap-6 p-4 md:p-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">Users</h1>
          <p className="text-[12px] text-ink-2">
            Staff, owners and drivers. Customer portal accounts aren&apos;t listed. Owner only.
          </p>
        </div>
        <Link
          href="/users/new"
          className="bg-teal px-4 py-2.5 text-[13px] font-extrabold text-white hover:bg-teal-700"
        >
          Add new user
        </Link>
      </div>

      {protectedUsers.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className={sectionTitle}>Protected</h2>
          {protectedUsers.map((u) => (
            <ProtectedCard key={u.id} user={u} />
          ))}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className={sectionTitle}>Team ({active.length})</h2>
        <HeaderRow />
        {active.length === 0 && <p className="text-[12px] text-ink-2">No one yet.</p>}
        {active.map((u) => (
          <UserRow key={u.id} user={u} trucks={trucks} isSelf={u.id === me.userId} selfEmail={me.email} />
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className={sectionTitle}>Pending invites ({pending.length})</h2>
        {pending.length === 0 && <p className="text-[12px] text-ink-2">No invites waiting.</p>}
        {pending.map((u) => (
          <UserRow key={u.id} user={u} trucks={trucks} isSelf={false} selfEmail={me.email} />
        ))}
      </section>

      {removed.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className={sectionTitle}>Removed ({removed.length})</h2>
          {removed.map((u) => (
            <UserRow key={u.id} user={u} trucks={trucks} isSelf={false} selfEmail={me.email} />
          ))}
        </section>
      )}
    </div>
  );
}

function HeaderRow() {
  return (
    <div className="hidden grid-cols-[1.4fr_1.6fr_0.7fr_1.1fr_0.8fr_1fr_auto] gap-3 px-3 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3 md:grid">
      <span>Name</span>
      <span>Email</span>
      <span>Role</span>
      <span>Driver</span>
      <span>Status</span>
      <span>Last sign-in</span>
      <span />
    </div>
  );
}
