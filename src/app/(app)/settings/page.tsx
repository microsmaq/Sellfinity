import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { planFor } from "@/lib/plans";
import { Badge, Card, PageHeader } from "@/components/ui";
import { EbayConnectionCard } from "./ebay-connection";

export const metadata = { title: "Settings — SellPilot" };

export default async function SettingsPage() {
  const user = await requireUser();
  const connection = await db.ebayConnection.findUnique({
    where: { userId: user.id },
  });

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

        <EbayConnectionCard
          status={(connection?.status ?? "DISCONNECTED") as "DISCONNECTED" | "SANDBOX" | "CONNECTED"}
          username={connection?.ebayUsername ?? null}
          connectedAt={connection?.connectedAt?.toISOString() ?? null}
        />
      </div>
    </>
  );
}
