"use client";

import { useActionState, useTransition } from "react";
import {
  connectEbaySandbox,
  disconnectEbay,
  type SettingsResult,
} from "@/lib/actions/settings";
import { Badge, Button, Card, Input, Label } from "@/components/ui";

export function EbayConnectionCard({
  status,
  username,
  connectedAt,
}: {
  status: "DISCONNECTED" | "SANDBOX" | "CONNECTED";
  username: string | null;
  connectedAt: string | null;
}) {
  const [state, formAction, pending] = useActionState<SettingsResult | null, FormData>(
    connectEbaySandbox,
    null,
  );
  const [disconnecting, startDisconnect] = useTransition();
  const connected = status !== "DISCONNECTED";

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">eBay seller account</h2>
        <Badge tone={connected ? "green" : "amber"}>
          {status === "SANDBOX"
            ? "Connected (sandbox)"
            : status === "CONNECTED"
              ? "Connected"
              : "Not connected"}
        </Badge>
      </div>

      {connected ? (
        <div className="mt-4 space-y-4 text-sm">
          <p className="text-slate-600">
            Connected as <span className="font-medium text-slate-900">{username}</span>
            {connectedAt &&
              ` since ${new Date(connectedAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })}`}
            . Publishing, inventory sync, and order import run against the{" "}
            <strong>built-in sandbox</strong> — no real eBay listings are created.
          </p>
          <Button
            variant="secondary"
            disabled={disconnecting}
            onClick={() => startDisconnect(async () => void (await disconnectEbay()))}
          >
            {disconnecting ? "Disconnecting…" : "Disconnect"}
          </Button>
        </div>
      ) : (
        <form action={formAction} className="mt-4 space-y-4">
          <p className="text-sm text-slate-600">
            Connect your eBay seller account to publish listings, sync inventory,
            and import orders.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="username">eBay username</Label>
            <Input
              id="username"
              name="username"
              placeholder="your-ebay-username"
              required
            />
          </div>
          {state?.error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {state.error}
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Connecting…" : "Connect (sandbox mode)"}
          </Button>
          <p className="text-xs text-slate-500">
            Sandbox mode simulates eBay end-to-end so you can use the whole app
            without real credentials. Going live requires an eBay developer
            account: set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_RU_NAME,
            and this button becomes the real eBay OAuth consent flow.
          </p>
        </form>
      )}
    </Card>
  );
}
