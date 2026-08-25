"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { logout } from "@/lib/actions/auth";
import { AppIcon, SidebarNav } from "./nav";

export function MobileAppHeader({ user }: { user: { name: string; email: string; isAdmin: boolean } }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { document.body.style.overflow = open ? "hidden" : ""; return () => { document.body.style.overflow = ""; }; }, [open]);
  return <><header className="mobile-topbar sticky top-0 z-50 border-b border-slate-200/70 bg-white/85 backdrop-blur-xl md:hidden"><div className="flex h-14 items-center justify-between px-4"><Link href={user.isAdmin ? "/admin" : "/dashboard"} className="text-[17px] font-bold tracking-tight text-slate-950">Sell<span className="text-indigo-600">finity</span></Link><button type="button" onClick={() => setOpen(true)} aria-label="Open navigation" className="grid h-10 w-10 place-items-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm active:scale-95"><span className="text-xs font-bold">{user.name.trim().slice(0, 1).toUpperCase()}</span></button></div></header>
    {open && <div className="fixed inset-0 z-[70] md:hidden"><button type="button" aria-label="Close navigation" onClick={() => setOpen(false)} className="animate-fade-in absolute inset-0 bg-slate-950/35 backdrop-blur-[2px]"/><section role="dialog" aria-modal="true" aria-label="App navigation" className="animate-sheet-in absolute inset-x-2 bottom-2 max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-[1.75rem] border border-white/70 bg-white p-3 shadow-2xl shadow-slate-950/25"><div className="mb-3 flex items-center justify-between px-2 pt-1"><div className="min-w-0"><p className="truncate text-sm font-bold text-slate-950">{user.name}</p><p className="truncate text-xs text-slate-500">{user.email}</p></div><button type="button" onClick={() => setOpen(false)} aria-label="Close navigation" className="grid h-10 w-10 place-items-center rounded-full bg-slate-100 text-xl text-slate-600">×</button></div><SidebarNav isAdmin={user.isAdmin} onNavigate={() => setOpen(false)}/><form action={logout} className="mt-3 border-t border-slate-200 pt-3"><button type="submit" className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-[13px] font-medium text-slate-600 active:bg-slate-100"><span className="grid h-8 w-8 place-items-center rounded-lg bg-slate-100"><AppIcon name="settings"/></span>Log out</button></form></section></div>}
  </>;
}
