import Link from "next/link";
import type { MirrorBatchHistoryPage } from "@/lib/actions/mirror-batches";
import { batchSourceMeta } from "@/lib/mirror/batch-labels";
import { Badge, Card } from "@/components/ui";

export function BatchHistory({ history }: { history: MirrorBatchHistoryPage }) {
  const { rows: batches, page, pageCount, total } = history;
  return (
    <div id="publishing-history">
    <Card className="overflow-hidden">
      <div className="border-b border-slate-200 px-5 py-4">
        <h2 className="font-semibold text-slate-900">Publishing batch history</h2>
        <p className="mt-1 text-sm text-slate-500">
          Every eBay publish, edit, optimization, ending, and sync result—including single items.
        </p>
      </div>
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="px-4 py-3">Started</th>
            <th className="px-4 py-3">Source</th>
            <th className="px-4 py-3 text-right">Items</th>
            <th className="px-4 py-3 text-right">Succeeded</th>
            <th className="px-4 py-3 text-right">Success</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Email</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => {
            const sourceMeta = batchSourceMeta(batch.source);
            const successPct = batch.totalCount
              ? Math.round((batch.succeededCount / batch.totalCount) * 100)
              : 0;
            const processedPct = batch.totalCount
              ? Math.round(((batch.succeededCount + batch.failedCount) / batch.totalCount) * 100)
              : 0;
            return (
              <tr key={batch.id} className="border-b border-slate-100 last:border-0">
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                  {new Date(batch.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-900">{sourceMeta.label}</div>
                  <div className="mt-1">
                    <Badge tone={batch.trigger === "AUTOMATIC" ? "indigo" : "slate"}>
                      {batch.trigger === "AUTOMATIC" ? "automatic" : "manual"}
                    </Badge>
                    {batch.improveMainImage && (
                      <span className="ml-2 text-xs font-medium text-violet-700">✨ AI images</span>
                    )}
                    {batch.improveListingContent && (
                      <span className="ml-2 text-xs font-medium text-indigo-700">AI copy</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{batch.totalCount}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {batch.succeededCount}
                  {batch.failedCount ? ` / ${batch.failedCount} failed` : ""}
                </td>
                <td className="min-w-32 px-4 py-3">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium tabular-nums text-slate-700">{successPct}% success</span>
                    <span className="tabular-nums text-slate-400">{processedPct}% done</span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={processedPct}>
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-indigo-600 via-violet-500 to-fuchsia-500 transition-[width] duration-700"
                      style={{ width: `${processedPct}%` }}
                    />
                  </div>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={batch.status === "COMPLETED" ? "green" : "indigo"}>
                    {batch.status.toLowerCase()}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  <Badge
                    tone={
                      batch.emailStatus === "SENT"
                        ? "green"
                        : batch.emailStatus === "FAILED"
                          ? "red"
                          : "slate"
                    }
                  >
                    {batch.emailStatus === "NOT_APPLICABLE"
                      ? "—"
                      : batch.emailStatus === "SENT"
                      ? "sent"
                      : batch.emailStatus === "FAILED"
                        ? "not sent"
                        : "pending"}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <Link href={`/mirror/batches/${batch.id}`} className="font-medium text-indigo-600 hover:underline">
                    View results →
                  </Link>
                </td>
              </tr>
            );
          })}
          {batches.length === 0 && (
            <tr>
              <td colSpan={8} className="px-5 py-10 text-center text-slate-500">
                No publishing batches yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-4 text-sm">
          <span className="text-slate-500">
            Page {page} of {pageCount} · {total} historical record{total === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-2">
            {page > 1 ? (
              <Link
                href={`/mirror?historyPage=${page - 1}#publishing-history`}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
              >
                ← Previous
              </Link>
            ) : (
              <span className="cursor-not-allowed rounded-lg border border-slate-200 px-3 py-1.5 text-slate-300">
                ← Previous
              </span>
            )}
            {page < pageCount ? (
              <Link
                href={`/mirror?historyPage=${page + 1}#publishing-history`}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
              >
                Next →
              </Link>
            ) : (
              <span className="cursor-not-allowed rounded-lg border border-slate-200 px-3 py-1.5 text-slate-300">
                Next →
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
    </div>
  );
}
