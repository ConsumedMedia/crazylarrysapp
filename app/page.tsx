import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen p-8 sm:p-20">
      <h1 className="text-2xl font-bold">Crazy Larry&apos;s Dumpsters</h1>
      <p className="mt-2 text-sm text-gray-500">
        Dumpster rental booking and operations platform.
      </p>
      <ul className="mt-6 list-disc pl-5 text-sm">
        <li>
          <Link className="underline" href="/book">
            Customer booking portal
          </Link>
        </li>
        <li>
          <Link className="underline" href="/dashboard">
            Admin / staff dashboard
          </Link>
        </li>
        <li>
          <Link className="underline" href="/driver">
            Driver dashboard
          </Link>
        </li>
      </ul>
    </main>
  );
}
