export type ApprovalItem = { id: string; asin: string; outcome: string; reason: string };
export type ApprovalProgress = { total: number; done: number; published: number; review: number; failed: number; skipped: number; items: ApprovalItem[] };
type Checkpoint = { skipped: boolean; reason: string } | { eligibleIds: string[]; items: ApprovalItem[] };

/** A frozen queue prevents held candidates being selected again in this run.
 * Small checkpoints stay within server time limits and permit safe stopping. */
export async function processCatalogApprovalQueue(ids: string[], review: (ids: string[]) => Promise<Checkpoint>, controls: { shouldStop: () => boolean; onProgress: (progress: ApprovalProgress) => void }) {
  let remaining = [...new Set(ids)];
  const progress: ApprovalProgress = { total: remaining.length, done: 0, published: 0, review: 0, failed: 0, skipped: 0, items: [] };
  controls.onProgress({ ...progress });
  while (remaining.length && !controls.shouldStop()) {
    const group = remaining.slice(0, 5);
    const result = await review(group);
    if ("skipped" in result) return { ...progress, stopped: false, pauseReason: result.reason };
    const eligible = new Set(result.eligibleIds);
    const completed = result.items.filter((item) => group.includes(item.id));
    const finished = new Set(completed.map((item) => item.id));
    if (finished.size !== completed.length) throw new Error("Approval checkpoint returned duplicate results.");
    const skipped = group.filter((id) => !eligible.has(id) && !finished.has(id));
    for (const id of skipped) finished.add(id);
    if (!finished.size) return { ...progress, stopped: false, pauseReason: "No progress was reported. Completed approvals are saved; check the connection before retrying." };
    for (const item of completed) {
      if (item.outcome === "published") progress.published++;
      else if (item.outcome === "failed") progress.failed++;
      else progress.review++;
    }
    progress.skipped += skipped.length;
    progress.done += finished.size;
    progress.items = [...progress.items, ...completed];
    remaining = remaining.filter((id) => !finished.has(id));
    controls.onProgress({ ...progress });
  }
  return { ...progress, stopped: remaining.length > 0, pauseReason: "" };
}
