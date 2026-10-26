export type ApprovalItem = { id: string; asin: string; outcome: string; reason: string };
export type ApprovalProgress = { total: number; done: number; published: number; review: number; failed: number; skipped: number; items: ApprovalItem[] };
type Checkpoint = { skipped: boolean; reason: string } | { eligibleIds: string[]; items: ApprovalItem[]; pauseReason?: string; retryAfterSeconds?: number; retryIds?: string[] };
export type ApprovalWait = { reason: string; remainingSeconds: number };

/** A frozen queue prevents held candidates being selected again in this run.
 * Small checkpoints stay within server time limits and permit safe stopping. */
export async function processCatalogApprovalQueue(ids: string[], review: (ids: string[]) => Promise<Checkpoint>, controls: { shouldStop: () => boolean; onProgress: (progress: ApprovalProgress) => void; onWaiting?: (waiting: ApprovalWait | null) => void; wait?: (ms: number) => Promise<void> }) {
  let remaining = [...new Set(ids)];
  const progress: ApprovalProgress = { total: remaining.length, done: 0, published: 0, review: 0, failed: 0, skipped: 0, items: [] };
  controls.onProgress({ ...progress });
  while (remaining.length && !controls.shouldStop()) {
    const group = remaining.slice(0, 5);
    const result = await review(group);
    if ("skipped" in result) return { ...progress, stopped: false, pauseReason: result.reason };
    const eligible = new Set(result.eligibleIds);
    const retryIds = new Set((result.retryIds || []).filter((id) => group.includes(id)));
    const completed = result.items.filter((item) => group.includes(item.id) && !retryIds.has(item.id));
    const finished = new Set(completed.map((item) => item.id));
    if (finished.size !== completed.length) throw new Error("Approval checkpoint returned duplicate results.");
    const skipped = group.filter((id) => !eligible.has(id) && !finished.has(id) && !retryIds.has(id));
    for (const id of skipped) finished.add(id);
    const canResume = Boolean(result.pauseReason && Number.isFinite(result.retryAfterSeconds) && result.retryAfterSeconds! > 0 && retryIds.size);
    if (!finished.size && !canResume) return { ...progress, stopped: false, pauseReason: result.pauseReason || "No progress was reported. Completed approvals are saved; check the connection before retrying." };
    for (const item of completed) {
      if (item.outcome === "published") progress.published++;
      else if (item.outcome === "failed") progress.failed++;
      else progress.review++;
    }
    progress.skipped += skipped.length;
    progress.done += finished.size;
    const activity = new Map(progress.items.map((item) => [item.id, item]));
    for (const item of result.items.filter((item) => group.includes(item.id))) activity.set(item.id, item);
    progress.items = [...activity.values()];
    remaining = remaining.filter((id) => !finished.has(id));
    controls.onProgress({ ...progress });
    if (result.pauseReason && !canResume) return { ...progress, stopped: false, pauseReason: result.pauseReason };
    if (canResume) {
      const until = Date.now() + result.retryAfterSeconds! * 1000;
      const wait = controls.wait || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      try {
        while (Date.now() < until && !controls.shouldStop()) {
          controls.onWaiting?.({ reason: result.pauseReason!, remainingSeconds: Math.ceil((until - Date.now()) / 1000) });
          await wait(Math.min(1000, until - Date.now()));
        }
      } finally { controls.onWaiting?.(null); }
    }
  }
  return { ...progress, stopped: remaining.length > 0, pauseReason: "" };
}
