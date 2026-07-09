import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { parseSyncIssueDetails } from "@/lib/types";
import { PageHeader } from "@/components/ui";
import { InventoryView, type IssueRow, type RunRow } from "./inventory-view";

export const metadata = { title: "Inventory sync — Sellfinity" };

export default async function InventoryPage() {
  const user = await requireUser();

  const [openIssues, recentResolved, runs, activeCount] = await Promise.all([
    db.syncIssue.findMany({
      where: { userId: user.id, resolution: "OPEN" },
      include: { listing: { select: { title: true, priceCents: true, quantity: true } } },
      orderBy: { createdAt: "desc" },
    }),
    db.syncIssue.findMany({
      where: { userId: user.id, resolution: { in: ["AUTO_FIXED", "FIXED", "IGNORED"] } },
      include: { listing: { select: { title: true, priceCents: true, quantity: true } } },
      orderBy: { resolvedAt: "desc" },
      take: 20,
    }),
    db.syncRun.findMany({
      where: { userId: user.id },
      orderBy: { startedAt: "desc" },
      take: 10,
    }),
    db.listing.count({ where: { userId: user.id, status: "ACTIVE" } }),
  ]);

  const toRow = (i: (typeof openIssues)[number]): IssueRow => {
    const details = parseSyncIssueDetails(i.detailsJson);
    return {
      id: i.id,
      type: i.type as IssueRow["type"],
      listingTitle: i.listing.title,
      message: details.message,
      field: details.field ?? null,
      expected: details.expected ?? null,
      actual: details.actual ?? null,
      resolution: i.resolution as IssueRow["resolution"],
      createdAt: i.createdAt.toISOString(),
    };
  };

  const runRows: RunRow[] = runs.map((r) => ({
    id: r.id,
    startedAt: r.startedAt.toISOString(),
    listingsChecked: r.listingsChecked,
    issuesFound: r.issuesFound,
    issuesAutoFixed: r.issuesAutoFixed,
  }));

  return (
    <>
      <PageHeader
        title="Inventory sync"
        subtitle="Checks every active listing against live supplier stock and cost. Risky mismatches are corrected on eBay automatically; restock opportunities are flagged for your review."
      />
      <InventoryView
        openIssues={openIssues.map(toRow)}
        resolvedIssues={recentResolved.map(toRow)}
        runs={runRows}
        activeCount={activeCount}
      />
    </>
  );
}
