"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { fixIssue, runSync, type SyncSummary } from "@/lib/sync/engine";

function revalidate() {
  revalidatePath("/inventory");
  revalidatePath("/listings");
}

export async function runSyncNow(): Promise<SyncSummary | { error: string }> {
  const user = await requireUser();
  // Sync revises live eBay listings, so it needs the connection.
  const connection = await db.ebayConnection.findUnique({ where: { userId: user.id } });
  if (!connection || connection.status === "DISCONNECTED") {
    return { error: "Connect your eBay account in Settings before syncing." };
  }
  const summary = await runSync({ id: user.id, plan: user.plan });
  revalidate();
  return summary;
}

export async function fixIssueNow(issueId: string): Promise<{ error?: string }> {
  const user = await requireUser();
  const error = await fixIssue(user.id, issueId);
  revalidate();
  return error ? { error } : {};
}

export async function ignoreIssue(issueId: string): Promise<void> {
  const user = await requireUser();
  await db.syncIssue.updateMany({
    where: { id: issueId, userId: user.id, resolution: "OPEN" },
    data: { resolution: "IGNORED", resolvedAt: new Date() },
  });
  revalidate();
}
