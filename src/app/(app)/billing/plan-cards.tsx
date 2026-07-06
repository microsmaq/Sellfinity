"use client";

import { useState, useTransition } from "react";
import { changePlan } from "@/lib/actions/billing";
import { formatCents } from "@/lib/money";
import { Badge, Button, Card, cx } from "@/components/ui";

type PlanView = {
  id: string;
  name: string;
  priceCentsMonthly: number;
  maxActiveListings: number | null; // null = unlimited
  autoFix: boolean;
  blurb: string;
};

export function PlanCards({
  plans,
  currentPlan,
  activeCount,
  renewsAt,
}: {
  plans: PlanView[];
  currentPlan: string;
  activeCount: number;
  renewsAt: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function select(planId: string) {
    setError(null);
    startTransition(async () => {
      const result = await changePlan(planId);
      if (result.error) setError(result.error);
    });
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        {plans.map((p) => {
          const current = p.id === currentPlan;
          return (
            <Card
              key={p.id}
              className={cx("flex flex-col p-6", current && "ring-2 ring-indigo-600")}
            >
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-900">{p.name}</h2>
                {current && <Badge tone="indigo">Current plan</Badge>}
              </div>
              <p className="mt-3 text-3xl font-semibold text-slate-900">
                {p.priceCentsMonthly === 0 ? "Free" : formatCents(p.priceCentsMonthly)}
                {p.priceCentsMonthly > 0 && (
                  <span className="text-sm font-normal text-slate-500">/month</span>
                )}
              </p>
              <p className="mt-2 text-sm text-slate-600">{p.blurb}</p>
              <ul className="mt-4 space-y-1.5 text-sm text-slate-600">
                <li>
                  ✓{" "}
                  {p.maxActiveListings === null
                    ? "Unlimited active listings"
                    : `Up to ${p.maxActiveListings} active listings`}
                </li>
                <li>✓ AI product sourcing feed</li>
                <li>✓ Bulk listing & profit tracking</li>
                <li className={p.autoFix ? "" : "text-slate-400 line-through"}>
                  ✓ Auto-fix inventory sync
                </li>
              </ul>
              <div className="mt-6 flex-1" />
              {current ? (
                renewsAt && (
                  <p className="text-xs text-slate-500">
                    Renews{" "}
                    {new Date(renewsAt).toLocaleDateString("en-US", {
                      month: "long",
                      day: "numeric",
                    })}{" "}
                    (simulated)
                  </p>
                )
              ) : (
                <Button disabled={pending} onClick={() => select(p.id)}>
                  {pending ? "Switching…" : `Switch to ${p.name}`}
                </Button>
              )}
            </Card>
          );
        })}
      </div>
      <p className="text-xs text-slate-500">
        You currently have {activeCount} active listing{activeCount === 1 ? "" : "s"}.
        Downgrading requires being within the target plan&apos;s listing limit.
      </p>
    </div>
  );
}
