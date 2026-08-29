"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";

export type AppIconName = "dashboard" | "mirror" | "discover" | "source" | "listings" | "orders" | "sync" | "analytics" | "settings" | "admin" | "users" | "database" | "bestsellers";

export function AppIcon({ name, className = "h-5 w-5" }: { name: AppIconName; className?: string }) {
  const common = { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "dashboard") return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>;
  if (name === "mirror") return <svg {...common}><path d="M8 7H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/><path d="M16 3h5v5M10 14 21 3"/></svg>;
  if (name === "discover" || name === "source") return <svg {...common}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M8 11h6M11 8v6"/></svg>;
  if (name === "listings") return <svg {...common}><path d="M20 13 13 20l-9-9V4h7l9 9Z"/><circle cx="8.5" cy="8.5" r="1"/></svg>;
  if (name === "orders") return <svg {...common}><path d="m4 7 8-4 8 4-8 4-8-4Z"/><path d="M4 7v10l8 4 8-4V7M12 11v10"/></svg>;
  if (name === "sync") return <svg {...common}><path d="M20 7h-5V2M4 17h5v5"/><path d="M6.1 9A7 7 0 0 1 18.5 6L20 7M4 17l1.5 1A7 7 0 0 0 18 15"/></svg>;
  if (name === "analytics") return <svg {...common}><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/></svg>;
  if (name === "settings") return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.8-1L14.4 3h-4.8l-.4 3.1a8 8 0 0 0-1.8 1L5 6.1 3 9.5 5.1 11a7 7 0 0 0 0 2L3 14.5l2 3.4 2.4-1a8 8 0 0 0 1.8 1l.4 3.1h4.8l.4-3.1a8 8 0 0 0 1.8-1l2.4 1 2-3.4-2.1-1.5c.1-.3.1-.7.1-1Z"/></svg>;
  if (name === "users") return <svg {...common}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
  if (name === "database") return <svg {...common}><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>;
  if (name === "bestsellers") return <svg {...common}><path d="M4 19h16M6 16V9m6 7V5m6 11v-4"/><path d="m5 6 4-3 4 2 6-3"/></svg>;
  return <svg {...common}><path d="M12 3 4 6v5c0 5 3.4 8.7 8 10 4.6-1.3 8-5 8-10V6l-8-3Z"/><path d="M9 12l2 2 4-4"/></svg>;
}

export const appLinks: { href: string; label: string; shortLabel: string; icon: AppIconName }[] = [
  { href: "/dashboard", label: "Profit dashboard", shortLabel: "Home", icon: "dashboard" }, { href: "/mirror", label: "Amazon mirroring", shortLabel: "Mirror", icon: "mirror" },
  { href: "/arbitrage", label: "Arbitrage finder", shortLabel: "Discover", icon: "discover" }, { href: "/sourcing", label: "Product sourcing", shortLabel: "Source", icon: "source" },
  { href: "/listings", label: "Listings", shortLabel: "Listings", icon: "listings" }, { href: "/orders", label: "Fulfillment", shortLabel: "Orders", icon: "orders" },
  { href: "/inventory", label: "Inventory sync", shortLabel: "Sync", icon: "sync" }, { href: "/analytics", label: "Product analytics", shortLabel: "Analytics", icon: "analytics" },
  { href: "/settings", label: "Settings", shortLabel: "Settings", icon: "settings" },
];

export const adminLinks: { href: string; label: string; shortLabel: string; icon: AppIconName }[] = [
  { href: "/admin", label: "Admin dashboard", shortLabel: "Home", icon: "dashboard" },
  { href: "/admin/arbitrage", label: "Product intelligence", shortLabel: "Products", icon: "discover" },
  { href: "/admin/ebay-bestsellers", label: "eBay bestsellers", shortLabel: "Best", icon: "bestsellers" },
  { href: "/admin/users", label: "Users & stores", shortLabel: "Users", icon: "users" },
  { href: "/analytics", label: "Platform analytics", shortLabel: "Analytics", icon: "analytics" },
  { href: "/admin/data", label: "Data operations", shortLabel: "Data", icon: "database" },
  { href: "/admin/settings", label: "Admin settings", shortLabel: "Settings", icon: "settings" },
];

export function SidebarNav({ isAdmin = false, onNavigate }: { isAdmin?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const visibleLinks = isAdmin ? adminLinks : appLinks;
  return <nav className="flex flex-col gap-1">{visibleLinks.map((link) => { const exactAdminHome = link.href === "/admin"; const active = pathname === link.href || (!exactAdminHome && pathname.startsWith(`${link.href}/`)); return <Link key={link.href} href={link.href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={cx("group flex min-h-11 items-center gap-3 rounded-xl px-3 text-[13px] font-medium transition-all duration-200", active ? "bg-indigo-50 text-indigo-700 shadow-sm shadow-indigo-100/50" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950 active:scale-[.98]")}><span className={cx("grid h-8 w-8 place-items-center rounded-lg transition-colors", active ? "bg-white text-indigo-600 shadow-sm" : "text-slate-400 group-hover:text-slate-700")}><AppIcon name={link.icon} /></span>{link.label}{active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-indigo-500" />}</Link>; })}</nav>;
}
