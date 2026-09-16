import { requireOwner } from "@/lib/auth/requireStaff";
import { listAllProfiles } from "@/lib/users/manage";
import { listTrucks } from "@/lib/drivers/manage";
import { CreateUserForm } from "./_components/CreateUserForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "New user · Crazy Larry's" };

export default async function NewUserPage() {
  await requireOwner();
  const [profiles, trucks] = await Promise.all([listAllProfiles(), listTrucks()]);

  return (
    <div className="flex max-w-2xl flex-col gap-4 p-4 md:p-7">
      <div>
        <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
          New user
        </h1>
        <p className="text-[12px] text-ink-2">
          Invite someone new, or grant more access to an existing account —
          staff/owner access, driver access, or both at once. Owner only.
        </p>
      </div>
      <CreateUserForm profiles={profiles} trucks={trucks} />
    </div>
  );
}
