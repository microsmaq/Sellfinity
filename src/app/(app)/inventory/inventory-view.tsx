"use client";

import { useState, useTransition } from "react";
import { fixIssueNow, ignoreIssue, runSyncNow } from "@/lib/actions/sync";
import { formatCents } from "@/lib/money";
import { Badge, Button, Card, EmptyState, cx } from "@/components/ui";
import { PremiumProgress } from "@/components/premium-progress";

export type IssueRow = {
  id: string;
  type: "OUT_OF_STOCK" | "STOCK_DRIFT" | "COST_RISE" | "SUPPLIER_GONE";
  listingTitle: string;
  message: string;
  field: "quantity" | "price" | null;
  expected: number | null;
  actual: number | null;
  resolution: "OPEN" | "AUTO_FIXED" | "FIXED" | "IGNORED";
  createdAt: string;
};

export type RunRow = {
  id: string;
  startedAt: string;
  listingsChecked: number;
  issuesFound: number;
  issuesAutoFixed: number;
};

const typeLabels: Record<IssueRow["type"], { label: string; tone: "red" | "amber" | "indigo" }> = {
  OUT_OF_STOCK: { label: "Out of stock", tone: "red" },
  SUPPLIER_GONE: { label: "Supplier gone", tone: "red" },
  STOCK_DRIFT: { label: "Stock drift", tone: "amber" },
  COST_RISE: { label: "Selling at a loss", tone: "red" },
};

const resolutionLabels: Record<IssueRow["resolution"], string> = {
  OPEN: "Open",
  AUTO_FIXED: "Auto-fixed",
  FIXED: "Fixed",
  IGNORED: "Ignored",
};

function formatValue(field: IssueRow["field"], value: number | null): string {
  if (value === null) return "—";
  return field === "price" ? formatCents(value) : String(value);
}

function IssueTable({
  issues,
  showActions,
  onAction,
  pending,
}: {
  issues: IssueRow[];
  showActions: boolean;
  onAction?: (id: string, action: "fix" | "ignore") => void;
  pending?: boolean;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
          <th className="px-4 py-3">Issue</th>
          <th className="px-4 py-3">Listing</th>
          <th className="px-4 py-3">Detail</th>
          <th className="px-4 py-3 text-right">Listed → Should be</th>
          <th className="px-4 py-3">{showActions ? "" : "Outcome"}</th>
        </tr>
      </thead>
      <tbody>
        {issues.map((i) => {
          const t = typeLabels[i.type];
          return (
            <tr key={i.id} className="border-b border-slate-100 last:border-0 align-top">
              <td className="px-4 py-3">
                <Badge tone={t.tone}>{t.label}</Badge>
              </td>
              <td className="max-w-52 px-4 py-3">
                <p className="truncate font-medium text-slate-900" title={i.listingTitle}>
                  {i.listingTitle}
                </p>
              </td>
              <td className="max-w-md px-4 py-3 text-slate-600">{i.message}</td>
              <td className="px-4 py-3 text-right tabular-nums">
                {i.field
                  ? `${formatValue(i.field, i.actual)} → ${formatValue(i.field, i.expected)}`
                  : "—"}
              </td>
              <td className="px-4 py-3">
                {showActions && onAction ? (
                  <span className="flex justify-end gap-1.5">
                    <Button size="sm" disabled={pending} onClick={() => onAction(i.id, "fix")}>
                      Fix now
                    </Button>
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => onAction(i.id, "ignore")}>
                      Ignore
                    </Button>
                  </span>
                ) : (
                  <Badge tone={i.resolution === "IGNORED" ? "slate" : "green"}>
                    {resolutionLabels[i.resolution]}
                  </Badge>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function InventoryView({
  openIssues,
  resolvedIssues,
  runs,
  activeCount,
}: {
  openIssues: IssueRow[];
  resolvedIssues: IssueRow[];
  runs: RunRow[];
  activeCount: number;
}) {
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [syncProgress, setSyncProgress] = useState<{
    complete: boolean;
    checked: number;
    issues: number;
    fixed: number;
    error?: string;
  } | null>(null);

  function sync() {
    setNotice(null);
    setSyncProgress({ complete: false, checked: 0, issues: 0, fixed: 0 });
    startTransition(async () => {
      const s = await runSyncNow();
      if ("error" in s) {
        setSyncProgress({ complete: true, checked: 0, issues: 0, fixed: 0, error: s.error });
        setNotice({ text: s.error, error: true });
        return;
      }
      setSyncProgress({ complete: true, checked: s.listingsChecked, issues: s.issuesFound, fixed: s.issuesAutoFixed });
      setNotice({
        text: `Checked ${s.listingsChecked} listing${s.listingsChecked === 1 ? "" : "s"}: ${s.issuesFound} issue${s.issuesFound === 1 ? "" : "s"} found${s.issuesAutoFixed ? `, ${s.issuesAutoFixed} auto-fixed` : ""}.`,
        error: false,
      });
    });
  }

  function onAction(id: string, action: "fix" | "ignore") {
    setNotice(null);
    startTransition(async () => {
      if (action === "fix") {
        const r = await fixIssueNow(id);
        setNotice(
          r.error
            ? { text: r.error, error: true }
            : { text: "Issue fixed — the listing was updated.", error: false },
        );
      } else {
        await ignoreIssue(id);
        setNotice({ text: "Issue ignored.", error: false });
      }
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button onClick={sync} disabled={pending}>
          {pending ? "Syncing…" : "Run sync now"}
        </Button>
        <p className="text-sm text-slate-500">
          {activeCount} active listing{activeCount === 1 ? "" : "s"} to check
        </p>
        {notice && (
          <p
            className={cx(
              "rounded-lg px-3 py-1.5 text-sm",
              notice.error ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700",
            )}
          >
            {notice.text}
          </p>
        )}
      </div>

      {syncProgress && (
        <PremiumProgress
          title={syncProgress.complete ? "Inventory sync complete" : "Checking inventory health"}
          subtitle={syncProgress.error ?? (syncProgress.complete
            ? "Supplier stock and pricing checks are now reflected in your inventory."
            : `Checking ${activeCount} active listing${activeCount === 1 ? "" : "s"} for stock and cost changes.`)}
          percentage={syncProgress.complete ? 100 : undefined}
          status={syncProgress.error ? "error" : syncProgress.complete ? "complete" : "running"}
          stats={[
            { label: "listings checked", value: syncProgress.checked || activeCount },
            { label: "issues found", value: syncProgress.issues, tone: syncProgress.issues ? "warning" : "success" },
            { label: "auto-fixed", value: syncProgress.fixed, tone: "success" },
          ]}
        />
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-900">
          Open issues ({openIssues.length})
        </h2>
        {openIssues.length === 0 ? (
          <EmptyState
            title="No open issues"
            body="Everything is in sync. Run a sync to re-check your active listings against current supplier stock and pricing."
          />
        ) : (
          <Card className="overflow-x-auto">
            <IssueTable issues={openIssues} showActions onAction={onAction} pending={pending} />
          </Card>
        )}
      </section>

      {resolvedIssues.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Recently resolved</h2>
          <Card className="overflow-x-auto">
            <IssueTable issues={resolvedIssues} showActions={false} />
          </Card>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Sync history</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-slate-500">No syncs yet.</p>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3 text-right">Listings checked</th>
                  <th className="px-4 py-3 text-right">Issues found</th>
                  <th className="px-4 py-3 text-right">Auto-fixed</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3">
                      {new Date(r.startedAt).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{r.listingsChecked}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{r.issuesFound}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{r.issuesAutoFixed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>
    </div>
  );
}
