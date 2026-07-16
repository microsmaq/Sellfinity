import Link from "next/link";
import type { MirrorBatchHistoryRow } from "@/lib/actions/mirror-batches";
import { Badge, Card } from "@/components/ui";

export function BatchHistory({ batches }: { batches: MirrorBatchHistoryRow[] }) {
  return (
    <Card className="overflow-x-auto">
      <div className="border-b border-slate-200 px-5 py-4">
        <h2 className="font-semibold text-slate-900">Publishing batch history</h2>
        <p className="mt-1 text-sm text-slate-500">
          Every direct eBay publishing run and its item-level results.
        </p>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="px-4 py-3">Started</th>
            <th className="px-4 py-3">Source</th>
            <th className="px-4 py-3 text-right">Items</th>
            <th className="px-4 py-3 text-right">Published</th>
            <th className="px-4 py-3 text-right">Success</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Email</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => {
            const successPct = batch.totalCount
              ? Math.round((batch.succeededCount / batch.totalCount) * 100)
              : 0;
            return (
              <tr key={batch.id} className="border-b border-slate-100 last:border-0">
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                  {new Date(batch.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-3">
                  <div>{batch.source === "ARBITRAGE" ? "Arbitrage Finder" : "Amazon URLs"}</div>
                  <div className="mt-1">
                    <Badge tone={batch.trigger === "AUTOMATIC" ? "indigo" : "slate"}>
                      {batch.trigger === "AUTOMATIC" ? "automatic" : "manual"}
                    </Badge>
                    {batch.improveMainImage && (
                      <span className="ml-2 text-xs font-medium text-violet-700">✨ AI images</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{batch.totalCount}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {batch.succeededCount}
                  {batch.failedCount ? ` / ${batch.failedCount} failed` : ""}
                </td>
                <td className="px-4 py-3 text-right font-medium tabular-nums">{successPct}%</td>
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
                    {batch.emailStatus === "SENT"
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
    </Card>
  );
}
