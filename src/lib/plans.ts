import type { Plan } from "./types";

export type PlanDef = {
  id: Plan;
  name: string;
  priceCentsMonthly: number;
  maxActiveListings: number; // Infinity = unlimited
  /** Whether inventory sync may auto-fix issues (vs. flag-only). */
  autoFix: boolean;
  blurb: string;
};

export const PLAN_DEFS: Record<Plan, PlanDef> = {
  FREE: {
    id: "FREE",
    name: "Starter",
    priceCentsMonthly: 0,
    maxActiveListings: 10,
    autoFix: false,
    blurb: "Try the full workflow with up to 10 active listings.",
  },
  PRO: {
    id: "PRO",
    name: "Pro",
    priceCentsMonthly: 2900,
    maxActiveListings: 500,
    autoFix: true,
    blurb: "Up to 500 active listings with auto-fix inventory sync.",
  },
  SCALE: {
    id: "SCALE",
    name: "Scale",
    priceCentsMonthly: 9900,
    maxActiveListings: Infinity,
    autoFix: true,
    blurb: "Unlimited listings for high-volume resellers.",
  },
};

export function planFor(plan: string): PlanDef {
  return PLAN_DEFS[plan as Plan] ?? PLAN_DEFS.FREE;
}

/**
 * How many more listings this user may activate right now.
 * Infinity when the plan is unlimited.
 */
export function remainingListingSlots(plan: string, activeCount: number): number {
  const def = planFor(plan);
  if (def.maxActiveListings === Infinity) return Infinity;
  return Math.max(0, def.maxActiveListings - activeCount);
}
