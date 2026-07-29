import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { logout } from "@/lib/actions/auth";
import { SidebarNav } from "./nav";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  return (
    <div className="min-h-screen md:flex">
      <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur md:hidden">
        <div className="flex items-center justify-between gap-3">
          <Link href="/dashboard" className="text-lg font-semibold">
            Sell<span className="text-indigo-600">finity</span>
          </Link>
          <details className="group relative">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 marker:content-none">
              <span aria-hidden className="text-lg leading-none">☰</span>
              Menu
            </summary>
            <div className="fixed inset-x-3 top-[4.25rem] max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
              <SidebarNav isAdmin={user.role === "ADMIN"} />
              <div className="mt-3 border-t border-slate-200 px-3 pt-3">
                <p className="truncate text-sm font-medium text-slate-900">{user.name}</p>
                <p className="truncate text-xs text-slate-500">{user.email}</p>
                <form action={logout} className="mt-3">
                  <button type="submit" className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-left text-sm font-medium text-slate-700">
                    Log out
                  </button>
                </form>
              </div>
            </div>
          </details>
        </div>
      </header>
      <aside className="fixed inset-y-0 hidden w-60 flex-col border-r border-slate-200 bg-white px-4 py-5 md:flex">
        <Link href="/dashboard" className="mb-6 px-3 text-lg font-semibold">
          Sell<span className="text-indigo-600">finity</span>
        </Link>
        <SidebarNav isAdmin={user.role === "ADMIN"} />
        <div className="mt-auto border-t border-slate-200 pt-4">
          <div className="min-w-0 px-3">
            <p className="truncate text-sm font-medium text-slate-900">
              {user.name}
            </p>
            <p className="truncate text-xs text-slate-500">{user.email}</p>
            {user.role === "ADMIN" && (
              <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-indigo-600">
                Administrator
              </p>
            )}
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
      <main className="min-w-0 px-4 py-5 sm:px-6 md:ml-60 md:flex-1 md:px-8 md:py-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
