import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { ebayEnvConfig } from "@/lib/ebay/oauth";
import { planFor } from "@/lib/plans";
import { Badge, Card, PageHeader } from "@/components/ui";
import { EbayConnectionCard } from "./ebay-connection";

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
  const connection = await db.ebayConnection.findUnique({
    where: { userId: user.id },
  });
  const oauthConfig = ebayEnvConfig();
  const callback = CALLBACK_MESSAGES[(await searchParams).ebay ?? ""];

  return (
    <>
      <PageHeader title="Settings" subtitle="Your account and marketplace connections." />
      <div className="max-w-2xl space-y-6">
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
              <dt className="text-slate-500">Plan</dt>
              <dd>
                <Badge tone={user.plan === "FREE" ? "slate" : "indigo"}>
                  {planFor(user.plan).name}
                </Badge>
              </dd>
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
      </div>
    </>
  );
}
