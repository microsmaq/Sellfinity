import type { ReactNode } from "react";

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

const buttonVariants = {
  primary:
    "bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-300 shadow-sm shadow-indigo-900/10",
  secondary:
    "bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400",
  danger: "bg-red-600 text-white hover:bg-red-500 disabled:bg-red-300 shadow-sm",
  ghost: "text-slate-600 hover:bg-slate-100 disabled:text-slate-300",
} as const;

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof buttonVariants;
  size?: "sm" | "md";
}) {
  return (
    <button
      className={cx(
        "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl font-semibold transition-all duration-200 active:scale-[.98] disabled:cursor-not-allowed disabled:active:scale-100 sm:min-h-0",
        size === "sm" ? "px-2.5 py-2 text-xs sm:py-1.5" : "px-3.5 py-2 text-[13px]",
        buttonVariants[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Card({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "rounded-2xl border border-slate-200/90 bg-white shadow-[0_1px_2px_rgba(15,23,42,.04),0_8px_24px_rgba(15,23,42,.03)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

const badgeTones = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  red: "bg-red-50 text-red-700 ring-red-600/20",
  amber: "bg-amber-50 text-amber-700 ring-amber-600/20",
  slate: "bg-slate-100 text-slate-600 ring-slate-500/20",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
} as const;

export function Badge({
  tone = "slate",
  children,
}: {
  tone?: keyof typeof badgeTones;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset",
        badgeTones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        "block min-h-10 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm shadow-slate-900/[.02] placeholder-slate-400 transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/15",
        props.className,
      )}
    />
  );
}

export function Label({
  htmlFor,
  children,
}: {
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
      {children}
    </label>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col items-start justify-between gap-3 sm:mb-6 sm:flex-row sm:gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-slate-950 sm:text-2xl">
          {title}
        </h1>
        {subtitle && <p className="mt-1 max-w-2xl text-[13px] leading-5 text-slate-500 sm:text-sm">{subtitle}</p>}
      </div>
      {actions && <div className="flex w-full flex-wrap items-center gap-2 [&>*]:max-sm:flex-1 sm:w-auto">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center gap-2 px-5 py-12 text-center sm:px-6 sm:py-16">
      <p className="text-base font-medium text-slate-900">{title}</p>
      <p className="max-w-md text-sm text-slate-500">{body}</p>
      {action && <div className="mt-3">{action}</div>}
    </Card>
  );
}

export function StatCard({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "positive" | "negative";
}) {
  return (
    <Card className="min-w-0 px-4 py-3.5 sm:px-5 sm:py-4">
      <p className="truncate text-[10px] font-semibold uppercase tracking-[.09em] text-slate-500 sm:text-xs">
        {label}
      </p>
      <p
        className={cx(
          "mt-1 truncate text-xl font-bold tracking-tight tabular-nums sm:text-2xl",
          tone === "positive" && "text-emerald-600",
          tone === "negative" && "text-red-600",
          tone === "default" && "text-slate-900",
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </Card>
  );
}
