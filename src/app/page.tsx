import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

const features = [
  {
    title: "Amazon mirroring",
    body: "Paste an Amazon URL — or fifty — and get eBay listings with SEO titles, images, and profitable pricing.",
  },
  {
    title: "AI product sourcing",
    body: "A daily feed of trending products with demand, competition, and margin estimates baked in.",
  },
  {
    title: "One-click auto-listing",
    body: "Generate optimized titles, descriptions, and pricing, then publish to eBay in bulk.",
  },
  {
    title: "Inventory sync",
    body: "Supplier stock and cost changes are caught automatically before they become defects.",
  },
  {
    title: "Real profit tracking",
    body: "Revenue, eBay fees, shipping, and cost of goods — per item and over time.",
  },
];

export default async function LandingPage() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");

  return (
    <main className="flex-1">
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <span className="text-lg font-semibold tracking-tight">
          Sell<span className="text-indigo-600">Pilot</span>
        </span>
        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Log in
          </Link>
          <Link
            href="/register"
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-500"
          >
            Start free
          </Link>
        </div>
      </nav>

      <section className="mx-auto max-w-5xl px-6 pb-16 pt-20 text-center">
        <h1 className="mx-auto max-w-3xl text-5xl font-semibold tracking-tight text-slate-900">
          eBay reselling on autopilot
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-600">
          Find winning products, list them in one click, keep stock in sync, and
          know exactly what you profited — one tool instead of four.
        </p>
        <div className="mt-8">
          <Link
            href="/register"
            className="rounded-lg bg-indigo-600 px-6 py-3 text-base font-medium text-white shadow-sm hover:bg-indigo-500"
          >
            Start selling smarter
          </Link>
        </div>
      </section>

      <section className="mx-auto grid max-w-5xl gap-4 px-6 pb-24 sm:grid-cols-2">
        {features.map((f) => (
          <div
            key={f.title}
            className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
          >
            <h2 className="font-medium text-slate-900">{f.title}</h2>
            <p className="mt-1.5 text-sm text-slate-600">{f.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
