"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";
import { adminLinks, AppIcon, type AppIconName } from "./nav";

const items: { href: string; label: string; icon: AppIconName }[] = [
  { href: "/dashboard", label: "Home", icon: "dashboard" }, { href: "/arbitrage", label: "Discover", icon: "discover" },
  { href: "/listings", label: "Listings", icon: "listings" }, { href: "/orders", label: "Orders", icon: "orders" }, { href: "/analytics", label: "Analytics", icon: "analytics" },
];
export function MobileBottomNav({ isAdmin = false }: { isAdmin?: boolean }) { const pathname = usePathname(); const visibleItems = isAdmin ? adminLinks.slice(0, 5).map(({ href, shortLabel: label, icon }) => ({ href, label, icon })) : items; return <nav aria-label="Primary mobile navigation" className="fixed inset-x-0 bottom-0 z-50 border-t border-white/80 bg-white/90 px-2 pb-[max(.4rem,env(safe-area-inset-bottom))] pt-1.5 shadow-[0_-10px_30px_rgba(15,23,42,.08)] backdrop-blur-xl md:hidden"><div className="mx-auto grid max-w-md grid-cols-5">{visibleItems.map((item) => { const exactAdminHome = item.href === "/admin"; const active = pathname === item.href || (!exactAdminHome && pathname.startsWith(`${item.href}/`)); return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={cx("relative flex min-h-[3.15rem] flex-col items-center justify-center gap-0.5 rounded-xl text-[10px] font-semibold transition-all duration-200 active:scale-95", active ? "text-indigo-700" : "text-slate-400")}><span className={cx("grid h-7 w-10 place-items-center rounded-full transition-all duration-300", active && "bg-indigo-100")}><AppIcon name={item.icon} className={cx("h-5 w-5 transition-transform duration-300", active && "-translate-y-px scale-105")}/></span><span>{item.label}</span></Link>; })}</div></nav>; }
