"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { PLAN_DEFS } from "@/lib/plans";
import { PLANS, type Plan } from "@/lib/types";

export type ChangePlanResult = { error?: string };

/**
 * Stubbed checkout: switches the plan immediately with no payment.
 * A real integration (Stripe Checkout + webhooks) replaces the body of this
 * action; the plan-limit checks stay.
 */
export async function changePlan(plan: string): Promise<ChangePlanResult> {
  const user = await requireUser();
  if (!PLANS.includes(plan as Plan)) return { error: "Unknown plan" };
  if (plan === user.plan) return { error: "You're already on this plan" };

  const target = PLAN_DEFS[plan as Plan];
  // Count and switch in one transaction so a concurrent publish can't land
  // the account above the new plan's limit.
  const overLimit = await db.$transaction(async (tx) => {
    if (target.maxActiveListings !== Infinity) {
      const activeCount = await tx.listing.count({
        where: { userId: user.id, status: "ACTIVE" },
      });
      if (activeCount > target.maxActiveListings) return activeCount;
    }
    await tx.user.update({
      where: { id: user.id },
      data: {
        plan,
        planRenewsAt:
          plan === "FREE" ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    return null;
  });
  if (overLimit !== null) {
    return {
      error: `You have ${overLimit} active listings but ${target.name} allows ${target.maxActiveListings}. End some listings first.`,
    };
  }
  revalidatePath("/billing");
  revalidatePath("/listings");
  return {};
}
