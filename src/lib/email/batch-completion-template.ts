export type BatchCompletionEmailInput = {
  name: string;
  batchId: string;
  source: string;
  trigger: string;
  succeededCount: number;
  failedCount: number;
  totalCount: number;
  activeListingCount: number;
  completedAt: Date;
  appUrl: string;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
    };
    return entities[character];
  });
}

export function buildBatchCompletionEmail(input: BatchCompletionEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const firstName = input.name.trim().split(/\s+/)[0] || "there";
  const source = input.source === "ARBITRAGE" ? "Arbitrage Finder" : "Amazon URL";
  const runLabel = input.trigger === "AUTOMATIC" ? "automatic" : "manual";
  const successPct = input.totalCount
    ? Math.round((input.succeededCount / input.totalCount) * 100)
    : 0;
  const batchUrl = `${input.appUrl.replace(/\/$/, "")}/mirror/batches/${input.batchId}`;
  const date = input.completedAt.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Los_Angeles",
  });
  const subject = `Sellfinity batch complete: ${input.succeededCount} new listing${input.succeededCount === 1 ? "" : "s"} published`;

  const text = [
    `Hi ${firstName},`,
    "",
    `Your ${runLabel} ${source} publishing batch is complete.`,
    "",
    `New items published: ${input.succeededCount}`,
    `Items that need attention: ${input.failedCount}`,
    `Success rate: ${successPct}%`,
    `Total active listings now: ${input.activeListingCount}`,
    `Completed: ${date} PT`,
    "",
    `View the item-by-item results: ${batchUrl}`,
    "",
    "Thanks for using Sellfinity.",
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
  <div style="max-width:620px;margin:0 auto;padding:32px 16px">
    <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden">
      <div style="background:#4f46e5;color:#ffffff;padding:24px 28px">
        <div style="font-size:22px;font-weight:700">Sellfinity</div>
        <div style="margin-top:6px;font-size:15px;color:#e0e7ff">Your publishing batch is complete</div>
      </div>
      <div style="padding:28px">
        <p style="margin:0 0 16px;font-size:16px">Hi ${escapeHtml(firstName)},</p>
        <p style="margin:0 0 22px;line-height:1.6">Your ${runLabel} ${source} publishing batch has finished. Here is the update:</p>
        <table role="presentation" style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:10px">
          <tr><td style="padding:13px 16px;border-bottom:1px solid #e2e8f0">New items published</td><td style="padding:13px 16px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;color:#047857">${input.succeededCount}</td></tr>
          <tr><td style="padding:13px 16px;border-bottom:1px solid #e2e8f0">Items needing attention</td><td style="padding:13px 16px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700">${input.failedCount}</td></tr>
          <tr><td style="padding:13px 16px;border-bottom:1px solid #e2e8f0">Success rate</td><td style="padding:13px 16px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700">${successPct}%</td></tr>
          <tr><td style="padding:13px 16px">Total active listings now</td><td style="padding:13px 16px;text-align:right;font-weight:700;color:#4f46e5">${input.activeListingCount}</td></tr>
        </table>
        <p style="margin:18px 0 24px;font-size:13px;color:#64748b">Completed ${escapeHtml(date)} PT</p>
        <a href="${escapeHtml(batchUrl)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:8px">View batch results</a>
        <p style="margin:26px 0 0;line-height:1.6">Thanks for using Sellfinity.</p>
      </div>
    </div>
  </div>
</body></html>`;

  return { subject, html, text };
}
