"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createUrlMirrorBatch } from "@/lib/actions/mirror-batches";
import { Button, Card } from "@/components/ui";
import { PremiumProgress } from "@/components/premium-progress";

export function MirrorForm({
  ebayConnected,
}: {
  ebayConnected: boolean;
}) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const lineCount = input.split("\n").filter((line) => line.trim()).length;

  function run() {
    setError(null);
    startTransition(async () => {
      const result = await createUrlMirrorBatch(input);
      if (result.error || !result.batchId) {
        setError(result.error ?? "Could not create the publishing batch.");
        return;
      }
      setInput("");
      router.push(`/mirror/batches/${result.batchId}`);
    });
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <label htmlFor="urls" className="mb-2 block text-sm font-medium text-slate-700">
          Amazon product URLs (one per line, up to 50)
        </label>
        <textarea
          id="urls"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          rows={6}
          placeholder={"https://www.amazon.com/dp/B0ABCD1234\nhttps://www.amazon.com/gp/product/B0EFGH5678"}
          className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <p className="mt-2 text-sm text-slate-500">
          Each product is published directly to eBay at 30% above its live Amazon source price.
          No drafts are retained when publication fails.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            onClick={run}
            disabled={pending || lineCount === 0 || !ebayConnected}
          >
            {pending
              ? "Creating batch…"
              : `Publish ${lineCount || ""} product${lineCount === 1 ? "" : "s"} to eBay`}
          </Button>
          {!ebayConnected && (
            <span className="text-sm text-amber-700">
              Connect eBay in <Link href="/settings" className="underline">Settings</Link> first.
            </span>
          )}
          <span className="text-xs text-slate-500">
            Publishing automation and AI image options are managed in{" "}
            <Link href="/settings" className="font-medium text-indigo-600 hover:underline">
              Settings
            </Link>.
          </span>
        </div>
      </Card>

      {pending && (
        <PremiumProgress
          title="Preparing your publishing batch"
          subtitle={`Validating ${lineCount} Amazon product${lineCount === 1 ? "" : "s"} and creating item-level tracking.`}
          status="running"
          stats={[
            { label: "products queued", value: lineCount },
            { label: "publishing mode", value: "Direct to eBay", tone: "info" },
          ]}
        />
      )}

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
    </div>
  );
}
