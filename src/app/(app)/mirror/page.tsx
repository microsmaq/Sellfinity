import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Badge, PageHeader } from "@/components/ui";
import { MirrorForm } from "./mirror-form";
import { BatchHistory } from "./batch-history";
import { listMirrorBatchHistory } from "@/lib/actions/mirror-batches";

export const metadata = { title: "Amazon mirroring — Sellfinity" };

export default async function MirrorPage({
  searchParams,
}: {
  searchParams: Promise<{ historyPage?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const requestedHistoryPage = Number.parseInt(params.historyPage ?? "1", 10);
  const [connection, history] = await Promise.all([
    db.ebayConnection.findUnique({ where: { userId: user.id } }),
    listMirrorBatchHistory(
      Number.isFinite(requestedHistoryPage) ? requestedHistoryPage : 1,
      25,
    ),
  ]);
  const ebayConnected = !!connection && connection.status !== "DISCONNECTED";

  return (
    <>
      <PageHeader
        title="Amazon mirroring"
        subtitle="Publish Amazon products directly to eBay in tracked batches with SEO content and a 30% source-price markup."
        actions={
          <Badge tone={ebayConnected ? "green" : "amber"}>
            {ebayConnected ? "eBay connected" : "eBay not connected"}
          </Badge>
        }
      />
      <div className="space-y-6">
        <MirrorForm ebayConnected={ebayConnected} />
        <BatchHistory history={history} />
      </div>
    </>
  );
}
