"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";

const links = [
  { href: "/dashboard", label: "Profit dashboard", icon: "📊" },
  { href: "/mirror", label: "Amazon mirroring", icon: "🪞" },
  { href: "/arbitrage", label: "Arbitrage finder", icon: "⚖️" },
  { href: "/sourcing", label: "Product sourcing", icon: "🔍" },
  { href: "/listings", label: "Listings", icon: "🏷️" },
  { href: "/inventory", label: "Inventory sync", icon: "🔄" },
  { href: "/billing", label: "Billing", icon: "💳" },
  { href: "/settings", label: "Settings", icon: "⚙️" },
];

export function SidebarNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {links.map((l) => {
        const active = pathname === l.href || pathname.startsWith(l.href + "/");
        return (
          <Link
            key={l.href}
            href={l.href}
            className={cx(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-indigo-50 text-indigo-700"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
            )}
          >
            <span aria-hidden>{l.icon}</span>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
