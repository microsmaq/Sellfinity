import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { logout } from "@/lib/actions/auth";
import { planFor } from "@/lib/plans";
import { Badge } from "@/components/ui";
import { SidebarNav } from "./nav";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const plan = planFor(user.plan);

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 flex w-60 flex-col border-r border-slate-200 bg-white px-4 py-5">
        <Link href="/dashboard" className="mb-6 px-3 text-lg font-semibold">
          Sell<span className="text-indigo-600">Pilot</span>
        </Link>
        <SidebarNav />
        <div className="mt-auto border-t border-slate-200 pt-4">
          <div className="flex items-center justify-between px-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-slate-900">
                {user.name}
              </p>
              <p className="truncate text-xs text-slate-500">{user.email}</p>
            </div>
            <Badge tone={plan.id === "FREE" ? "slate" : "indigo"}>{plan.name}</Badge>
          </div>
          <form action={logout} className="mt-3 px-3">
            <button
              type="submit"
              className="text-xs font-medium text-slate-500 hover:text-slate-900"
            >
              Log out
            </button>
          </form>
        </div>
      </aside>
      <main className="ml-60 flex-1 px-8 py-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
