"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  createUrlMirrorBatch,
  setImproveMainImagePreference,
} from "@/lib/actions/mirror-batches";
import { Button, Card } from "@/components/ui";

export function MirrorForm({
  ebayConnected,
  initialImproveMainImage,
}: {
  ebayConnected: boolean;
  initialImproveMainImage: boolean;
}) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [improveMainImage, setImproveMainImage] = useState(initialImproveMainImage);
  const [savingImagePreference, startSavingImagePreference] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const lineCount = input.split("\n").filter((line) => line.trim()).length;

  function toggleImageImprovement(enabled: boolean) {
    const previous = improveMainImage;
    setImproveMainImage(enabled);
    startSavingImagePreference(async () => {
      try {
        await setImproveMainImagePreference(enabled);
      } catch {
        setImproveMainImage(previous);
        setError("Could not save the AI image preference. Please try again.");
      }
    });
  }

  function run() {
    setError(null);
    startTransition(async () => {
      const result = await createUrlMirrorBatch(input, improveMainImage);
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
        <label className="mt-4 flex cursor-pointer gap-3 rounded-xl border border-indigo-200 bg-gradient-to-r from-indigo-50 to-violet-50 p-4 transition hover:border-indigo-300">
          <input
            type="checkbox"
            checked={improveMainImage}
            disabled={savingImagePreference}
            onChange={(event) => toggleImageImprovement(event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          <span>
            <span className="flex items-center gap-2 font-semibold text-slate-900">
              <span aria-hidden="true">✨</span>
              AI-enhance the main listing image
            </span>
            <span className="mt-1 block text-sm leading-5 text-slate-600">
              Uses OpenAI image editing to create a premium, eBay-compliant white-background
              hero photo. The original Amazon photos stay as secondary images, and Sellfinity
              falls back safely if editing fails. This saved preference also applies to manual
              and automatic Arbitrage Finder publishing. Only enable this for images you are
              authorized to use and edit.
            </span>
          </span>
        </label>
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
        </div>
      </Card>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
    </div>
  );
}
