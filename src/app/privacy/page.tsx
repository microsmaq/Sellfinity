import Link from "next/link";

export const metadata = { title: "Privacy policy — Sellfinity" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <Link href="/" className="text-lg font-semibold">
        Sell<span className="text-indigo-600">finity</span>
      </Link>
      <h1 className="mt-8 text-3xl font-semibold tracking-tight text-slate-900">
        Privacy policy
      </h1>
      <div className="mt-6 space-y-4 text-sm leading-6 text-slate-600">
        <p>
          Sellfinity stores the information you provide when you create an
          account (name, email, and a hashed password) and the business data
          the product needs to operate: products you import, listings you
          create, orders imported from your connected marketplaces, and
          inventory sync history.
        </p>
        <p>
          When you connect an eBay seller account, we store the OAuth tokens
          eBay issues so we can publish and revise listings and import orders
          on your behalf. We request only the seller permissions the product
          uses (inventory, account policies, and order fulfillment). You can
          disconnect at any time in Settings, which invalidates the stored
          tokens.
        </p>
        <p>
          We do not sell your data or share it with third parties except the
          marketplaces and suppliers you explicitly connect. Payment details
          for subscriptions are handled by our payment processor and never
          touch our servers.
        </p>
        <p>
          To delete your account and all associated data, contact support.
          Questions about this policy: support@sellfinity.example.
        </p>
        <p className="text-xs text-slate-400">Last updated July 2026.</p>
      </div>
    </main>
  );
}
