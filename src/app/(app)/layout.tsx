import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { logout } from "@/lib/actions/auth";
import { SidebarNav } from "./nav";
import { MobileBottomNav } from "./mobile-bottom-nav";
import { MobileAppHeader } from "./mobile-app-header";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN";
  const homeHref = isAdmin ? "/admin" : "/dashboard";
  return <div className="min-h-screen md:flex">
    <MobileAppHeader user={{ name: user.name, email: user.email, isAdmin }} />
    <aside className="fixed inset-y-0 hidden w-60 flex-col border-r border-slate-200/80 bg-white/90 px-4 py-5 backdrop-blur-xl md:flex"><Link href={homeHref} className="mb-6 px-3 text-lg font-bold tracking-tight">Sell<span className="text-indigo-600">finity</span></Link><SidebarNav isAdmin={isAdmin}/><div className="mt-auto border-t border-slate-200 pt-4"><div className="min-w-0 px-3"><p className="truncate text-sm font-semibold text-slate-900">{user.name}</p><p className="truncate text-xs text-slate-500">{user.email}</p>{isAdmin && <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-indigo-600">Administrator</p>}</div><form action={logout} className="mt-3 px-3"><button type="submit" className="text-xs font-medium text-slate-500 transition hover:text-slate-900">Log out</button></form></div></aside>
    <main className="min-w-0 px-3 pb-28 pt-4 sm:px-6 md:ml-60 md:flex-1 md:px-8 md:py-8"><div className="app-page mx-auto max-w-6xl">{children}</div></main>
    <MobileBottomNav isAdmin={isAdmin} />
  </div>;
}
