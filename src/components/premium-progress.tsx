import type { ReactNode } from "react";
import { Card, cx } from "@/components/ui";

export type PremiumProgressStatus = "running" | "paused" | "complete" | "error";

export type PremiumProgressStat = {
  label: string;
  value: string | number;
  tone?: "default" | "success" | "warning" | "danger" | "info";
};

function ProgressIcon({ status }: { status: PremiumProgressStatus }) {
  if (status === "complete") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5">
        <path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "paused") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5">
        <path d="M9 7v10M15 7v10" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "error") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5">
        <path d="M12 8v5M12 17h.01" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5 animate-spin">
      <path d="M20 12a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M20 5v7h-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const statTones = {
  default: "bg-white text-slate-600 ring-slate-200",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warning: "bg-amber-50 text-amber-700 ring-amber-200",
  danger: "bg-red-50 text-red-700 ring-red-200",
  info: "bg-cyan-50 text-cyan-700 ring-cyan-200",
} as const;

export function PremiumProgress({
  title,
  subtitle,
  percentage,
  status = "running",
  stats = [],
  action,
  className,
}: {
  title: string;
  subtitle?: string;
  percentage?: number;
  status?: PremiumProgressStatus;
  stats?: PremiumProgressStat[];
  action?: ReactNode;
  className?: string;
}) {
  const safePercentage = Math.max(0, Math.min(100, Math.round(percentage ?? 8)));
  const isIndeterminate = percentage === undefined && status === "running";
  const shellTone =
    status === "error"
      ? "border-red-200 from-red-50 via-white to-rose-50 shadow-red-100/60"
      : status === "complete"
        ? "border-emerald-200 from-emerald-50 via-white to-cyan-50 shadow-emerald-100/60"
        : status === "paused"
          ? "border-amber-200 from-amber-50 via-white to-orange-50 shadow-amber-100/60"
          : "border-indigo-200 from-indigo-50 via-white to-violet-50 shadow-indigo-100/60";
  const iconTone =
    status === "error"
      ? "from-red-600 to-rose-600 shadow-red-200"
      : status === "complete"
        ? "from-emerald-600 to-teal-600 shadow-emerald-200"
        : status === "paused"
          ? "from-amber-500 to-orange-500 shadow-amber-200"
          : "from-indigo-600 to-violet-600 shadow-indigo-200";
  const progressTone =
    status === "error"
      ? "from-red-600 via-rose-500 to-orange-400"
      : status === "complete"
        ? "from-emerald-600 via-teal-500 to-cyan-500"
        : status === "paused"
          ? "from-amber-500 via-orange-400 to-yellow-400"
          : "from-indigo-600 via-violet-500 to-fuchsia-500";

  return (
    <Card className={cx("relative overflow-hidden bg-gradient-to-br px-5 py-4 shadow-md", shellTone, className)}>
      <div className="absolute -right-8 -top-10 h-28 w-28 rounded-full bg-violet-200/30 blur-2xl" />
      <div className="relative flex items-start gap-3">
        <div className={cx("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-lg", iconTone)}>
          <ProgressIcon status={status} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold text-slate-900">{title}</p>
              {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
            </div>
            <div className="flex items-center gap-3">
              {action}
              <span className="text-sm font-semibold tabular-nums text-indigo-700">{safePercentage}%</span>
            </div>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-indigo-100/80" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={safePercentage}>
            <div
              className={cx(
                "h-full rounded-full bg-gradient-to-r transition-[width] duration-700 ease-out",
                progressTone,
                isIndeterminate && "animate-pulse",
              )}
              style={{ width: `${safePercentage}%` }}
            />
          </div>
          {stats.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {stats.map((stat) => (
                <span key={stat.label} className={cx("rounded-full px-2.5 py-1 shadow-sm ring-1", statTones[stat.tone ?? "default"])}>
                  <span className="font-semibold tabular-nums">{stat.value}</span> {stat.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
