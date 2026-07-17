import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { ebayEnvConfig } from "@/lib/ebay/oauth";
import { Card, PageHeader } from "@/components/ui";
import { EbayConnectionCard } from "./ebay-connection";
import { getRainforestEfficiencySummary } from "@/lib/mirror/rainforest";
import { PublishingPreferences } from "./publishing-preferences";

export const metadata = { title: "Settings — Sellfinity" };

const CALLBACK_MESSAGES: Record<string, { text: string; error: boolean }> = {
  connected: { text: "eBay account connected.", error: false },
  declined: { text: "eBay connection was declined or cancelled.", error: true },
  state_mismatch: {
    text: "eBay connection failed a security check — please try again.",
    error: true,
  },
  token_error: {
    text: "eBay rejected the token exchange. Check the keyset and RuName in .env, then try again.",
    error: true,
  },
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ebay?: string }>;
}) {
  const user = await requireUser();
  const [connection, rainforest] = await Promise.all([
    db.ebayConnection.findUnique({ where: { userId: user.id } }),
    getRainforestEfficiencySummary(),
  ]);
  const oauthConfig = ebayEnvConfig();
  const callback = CALLBACK_MESSAGES[(await searchParams).ebay ?? ""];

  return (
    <>
      <PageHeader title="Settings" subtitle="Manage your account, publishing preferences, and marketplace connections." />
      <div className="max-w-3xl space-y-6">
        <Card className="p-6">
          <h2 className="text-sm font-semibold text-slate-900">Account</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Name</dt>
              <dd className="font-medium text-slate-900">{user.name}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Email</dt>
              <dd className="font-medium text-slate-900">{user.email}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Member since</dt>
              <dd className="font-medium text-slate-900">
                {user.createdAt.toLocaleDateString("en-US", {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
              </dd>
            </div>
          </dl>
        </Card>

        <PublishingPreferences
          initialAutoPublish={user.autoPublishArbitrage}
          initialImproveMainImage={user.improveMainImage}
          initialImproveListingContent={user.improveListingContent}
        />

        {callback && (
          <p
            className={`rounded-lg px-3 py-2 text-sm ${callback.error ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}
          >
            {callback.text}
          </p>
        )}
        <EbayConnectionCard
          status={(connection?.status ?? "DISCONNECTED") as "DISCONNECTED" | "SANDBOX" | "CONNECTED"}
          username={connection?.ebayUsername ?? null}
          connectedAt={connection?.connectedAt?.toISOString() ?? null}
          oauth={oauthConfig ? { env: oauthConfig.env } : null}
        />
        <Card className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Rainforest efficiency</h2>
              <p className="mt-1 text-xs text-slate-500">
                Paid provider requests and shared-cache savings for {rainforest.day} UTC.
              </p>
            </div>
            <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
              {rainforest.providerRequests + rainforest.cacheHits > 0
                ? `${Math.round((rainforest.cacheHits / (rainforest.providerRequests + rainforest.cacheHits)) * 100)}% cache hit`
                : "Ready"}
            </span>
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div className="rounded-lg bg-slate-50 p-3">
              <dt className="text-xs text-slate-500">Paid requests</dt>
              <dd className="mt-1 text-lg font-semibold text-slate-900">
                {rainforest.providerRequests}
                {rainforest.dailyBudget ? ` / ${rainforest.dailyBudget}` : ""}
              </dd>
            </div>
            <div className="rounded-lg bg-cyan-50 p-3">
              <dt className="text-xs text-cyan-700">Cache saves</dt>
              <dd className="mt-1 text-lg font-semibold text-cyan-900">{rainforest.cacheHits}</dd>
            </div>
            <div className="rounded-lg bg-amber-50 p-3">
              <dt className="text-xs text-amber-700">Failures</dt>
              <dd className="mt-1 text-lg font-semibold text-amber-900">{rainforest.failures}</dd>
            </div>
            <div className="rounded-lg bg-violet-50 p-3">
              <dt className="text-xs text-violet-700">Credits remaining</dt>
              <dd className="mt-1 text-lg font-semibold text-violet-900">
                {rainforest.account?.creditsRemaining ?? "—"}
              </dd>
            </div>
          </dl>
          {rainforest.budgetBlocks > 0 && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {rainforest.budgetBlocks} request{rainforest.budgetBlocks === 1 ? " was" : "s were"} safely paused by the credit budget today.
            </p>
          )}
          {rainforest.dailyBudget && (
            <p className="mt-3 text-xs leading-5 text-slate-500">
              Paid lookups pause at {rainforest.dailyBudget} per UTC day and preserve at least {rainforest.minimumReserve} account credits. Cached lookups do not count toward this limit.
            </p>
          )}
        </Card>
      </div>
    </>
  );
}
