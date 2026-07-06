import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { PLAN_DEFS } from "@/lib/plans";
import { PageHeader } from "@/components/ui";
import { PlanCards } from "./plan-cards";

export const metadata = { title: "Billing — SellPilot" };

export default async function BillingPage() {
  const user = await requireUser();
  const activeCount = await db.listing.count({
    where: { userId: user.id, status: "ACTIVE" },
  });

  const plans = Object.values(PLAN_DEFS).map((p) => ({
    id: p.id,
    name: p.name,
    priceCentsMonthly: p.priceCentsMonthly,
    maxActiveListings: p.maxActiveListings === Infinity ? null : p.maxActiveListings,
    autoFix: p.autoFix,
    blurb: p.blurb,
  }));

  return (
    <>
      <PageHeader
        title="Billing"
        subtitle="Payment processing is stubbed — plan changes apply instantly without charging anything. Stripe slots in here for production."
      />
      <PlanCards
        plans={plans}
        currentPlan={user.plan}
        activeCount={activeCount}
        renewsAt={user.planRenewsAt?.toISOString() ?? null}
      />
    </>
  );
}
