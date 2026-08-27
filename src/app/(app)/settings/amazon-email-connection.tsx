"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card } from "@/components/ui";
import {
  checkAmazonPurchasesNow,
  disconnectAmazonEmail,
  setAutoUploadTracking,
} from "@/lib/actions/amazon-email";

type AmazonEmailConnection = {
  email: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  autoUploadTracking: boolean;
};

export function AmazonEmailConnectionCard({ configured, connection }: {
  configured: boolean;
  connection: AmazonEmailConnection | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [autoTracking, setAutoTracking] = useState(connection?.autoUploadTracking ?? false);
  const [lastCheckedAt, setLastCheckedAt] = useState(connection?.lastSyncedAt ?? null);

  function checkPurchases() {
    setMessage({ text: "Securely checking recent Amazon purchase emails…", error: false });
    startTransition(async () => {
      try {
        const result = await checkAmazonPurchasesNow();
        if ("error" in result) {
          setMessage({ text: result.error ?? "Amazon email check failed.", error: true });
          return;
        }
        setLastCheckedAt(result.checkedAt);
        setMessage({
          text: `Checked ${result.examined} recent messages · ${result.imported} purchase update${result.imported === 1 ? "" : "s"} saved · ${result.matched} order match${result.matched === 1 ? "" : "es"}.`,
          error: false,
        });
      } catch {
        setMessage({ text: "The Amazon email check could not finish. Please try again.", error: true });
      }
    });
  }

  function toggleTracking(enabled: boolean) {
    const previous = autoTracking;
    setAutoTracking(enabled);
    startTransition(async () => {
      try {
        await setAutoUploadTracking(enabled);
        setMessage({
          text: enabled ? "Automatic eBay tracking updates enabled." : "Automatic eBay tracking updates disabled.",
          error: false,
        });
      } catch {
        setAutoTracking(previous);
        setMessage({ text: "Could not update the tracking preference.", error: true });
      }
    });
  }

  function disconnect() {
    startTransition(async () => {
      await disconnectAmazonEmail();
      router.refresh();
    });
  }

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Amazon purchase detection</h2>
          <p className="mt-1 max-w-xl text-xs leading-5 text-slate-500">Connect Gmail read-only to recognize Amazon confirmations and shipment updates. Sellfinity stores purchase facts—not email bodies—and uses them to reconcile actual fulfillment costs.</p>
        </div>
        <Badge tone={connection ? "green" : configured ? "amber" : "slate"}>{connection ? "Connected" : configured ? "Ready to connect" : "Not configured"}</Badge>
      </div>

      {connection && <>
        <div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
          <p className="font-medium text-slate-900">{connection.email || "Google account"}</p>
          <p className="mt-1">Last checked: {lastCheckedAt ? new Date(lastCheckedAt).toLocaleString() : "Not yet synced"}</p>
          {connection.lastSyncError && !message && <p className="mt-1 text-red-600">{connection.lastSyncError}</p>}
        </div>
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-indigo-600" checked={autoTracking} disabled={pending} onChange={(event) => toggleTracking(event.target.checked)} />
          <span>
            <span className="block text-sm font-semibold text-slate-900">Automatically update tracking on eBay</span>
            <span className="mt-1 block text-xs leading-5 text-slate-500">When Amazon reports shipment tracking, Sellfinity uploads it only for a single-item purchase whose ASIN exactly matches the eBay listing source. Ambiguous and multi-item purchases stay pending for review.</span>
          </span>
        </label>
      </>}

      {message && <p className={`mt-3 rounded-lg px-3 py-2 text-xs ${message.error ? "bg-red-50 text-red-700" : "bg-indigo-50 text-indigo-700"}`} role="status">{message.text}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        {!connection
          ? <a href={configured ? "/api/amazon-email/connect" : undefined} aria-disabled={!configured} className={`inline-flex rounded-lg px-4 py-2 text-sm font-medium ${configured ? "bg-indigo-600 text-white hover:bg-indigo-500" : "cursor-not-allowed bg-slate-200 text-slate-500"}`}>Connect Gmail</a>
          : <>
            <Button disabled={pending} onClick={checkPurchases}>{pending ? "Checking emails…" : "Check Amazon emails"}</Button>
            <Button variant="secondary" disabled={pending} onClick={disconnect}>Disconnect</Button>
          </>}
      </div>
      {connection && <p className="mt-3 text-xs leading-5 text-slate-500">This quick check updates Amazon purchases without reloading Settings. Use Fulfillment refresh for eBay orders, tracking uploads, price protection, and stock updates.</p>}
      {!configured && <p className="mt-3 text-xs text-amber-700">The site owner must configure Google OAuth before accounts can connect.</p>}
    </Card>
  );
}
