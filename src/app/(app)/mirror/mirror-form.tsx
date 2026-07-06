"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { mirrorUrls, type MirrorResult } from "@/lib/actions/mirror";
import { formatCents } from "@/lib/money";
import { Badge, Button, Card, cx } from "@/components/ui";

export function MirrorForm({ ebayConnected }: { ebayConnected: boolean }) {
  const [input, setInput] = useState("");
  const [publishNow, setPublishNow] = useState(false);
  const [result, setResult] = useState<MirrorResult | null>(null);
  const [pending, startTransition] = useTransition();

  const lineCount = input.split("\n").filter((l) => l.trim()).length;

  function run() {
    startTransition(async () => {
      const r = await mirrorUrls(input, publishNow);
      setResult(r);
      if (!r.error && r.outcomes.some((o) => o.ok)) setInput("");
    });
  }

  const okCount = result?.outcomes.filter((o) => o.ok).length ?? 0;
  const failCount = (result?.outcomes.length ?? 0) - okCount;

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <label
          htmlFor="urls"
          className="mb-2 block text-sm font-medium text-slate-700"
        >
          Amazon product URLs (one per line, up to 50)
        </label>
        <textarea
          id="urls"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={6}
          placeholder={"https://www.amazon.com/dp/B0ABCD1234\nhttps://www.amazon.com/gp/product/B0EFGH5678"}
          className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <Button onClick={run} disabled={pending || lineCount === 0}>
            {pending
              ? "Mirroring…"
              : `Mirror ${lineCount || ""} product${lineCount === 1 ? "" : "s"}`}
          </Button>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={publishNow}
              onChange={(e) => setPublishNow(e.target.checked)}
              disabled={!ebayConnected}
            />
            Publish to eBay immediately
            {!ebayConnected && (
              <span className="text-xs text-slate-400">
                (connect eBay in{" "}
                <Link href="/settings" className="text-indigo-600">
                  Settings
                </Link>
                )
              </span>
            )}
          </label>
        </div>
      </Card>

      {result?.error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {result.error}
        </p>
      )}

      {result && result.outcomes.length > 0 && (
        <>
          <div className="flex items-center gap-2 text-sm">
            <Badge tone={okCount > 0 ? "green" : "slate"}>{okCount} mirrored</Badge>
            {failCount > 0 && <Badge tone="red">{failCount} failed</Badge>}
            {result.publish && (
              <Badge tone={result.publish.error ? "amber" : "indigo"}>
                {result.publish.done} published
                {result.publish.failed ? `, ${result.publish.failed} not published` : ""}
              </Badge>
            )}
            {result.publish?.error && (
              <span className="text-amber-700">{result.publish.error}</span>
            )}
            {okCount > 0 && !result.publish && (
              <Link href="/listings" className="font-medium text-indigo-600">
                Review drafts in Listings →
              </Link>
            )}
          </div>
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3">URL</th>
                  <th className="px-4 py-3">Result</th>
                  <th className="px-4 py-3 text-right">List price</th>
                </tr>
              </thead>
              <tbody>
                {result.outcomes.map((o) => (
                  <tr key={o.url} className="border-b border-slate-100 last:border-0 align-top">
                    <td className="max-w-60 px-4 py-3">
                      <p className="truncate font-mono text-xs text-slate-500" title={o.url}>
                        {o.url}
                      </p>
                    </td>
                    <td className={cx("max-w-md px-4 py-3", !o.ok && "text-red-700")}>
                      {o.ok ? o.title : o.error}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {o.priceCents !== undefined ? formatCents(o.priceCents) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
