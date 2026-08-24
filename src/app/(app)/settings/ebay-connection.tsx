"use client";

import { useActionState, useTransition } from "react";
import {
  completeEbayConnectionFromUrl,
  connectEbaySandbox,
  disconnectEbay,
  type SettingsResult,
} from "@/lib/actions/settings";
import { Badge, Button, Card, Input, Label } from "@/components/ui";

function PasteCallbackForm() {
  const [state, formAction, pending] = useActionState<SettingsResult | null, FormData>(
    completeEbayConnectionFromUrl,
    null,
  );
  return (
    <form action={formAction} className="space-y-2">
      <p className="text-xs text-slate-500">
        If eBay couldn&apos;t send you back here after you granted access (its
        settings won&apos;t accept a localhost return URL), copy the full URL
        from the browser address bar on the page you ended up on and paste it
        below:
      </p>
      <div className="flex gap-2">
        <Input
          name="url"
          placeholder="https://…?code=v^1.1#i^1…&state=…"
          required
          className="font-mono text-xs"
        />
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Completing…" : "Complete connection"}
        </Button>
      </div>
      {state?.error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}
    </form>
  );
}

export function EbayConnectionCard({
  status,
  username,
  connectedAt,
  oauth,
  financialsAccess,
}: {
  status: "DISCONNECTED" | "SANDBOX" | "CONNECTED";
  username: string | null;
  connectedAt: string | null;
  /** Present when a real eBay keyset (incl. RuName) is configured in env. */
  oauth: { env: "SANDBOX" | "PRODUCTION" } | null;
  financialsAccess: boolean;
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
            ? "Connected (demo sandbox)"
            : status === "CONNECTED"
              ? `Connected (eBay ${oauth?.env === "PRODUCTION" ? "production" : "sandbox"})`
              : "Not connected"}
        </Badge>
      </div>

      {connected ? (
        <div className="mt-4 space-y-4 text-sm">
          <p className="text-slate-600">
            Connected as <span className="font-medium text-slate-900">{username}</span>
            {connectedAt &&
              ` since ${new Date(connectedAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })}`}
            .{" "}
            {status === "SANDBOX" ? (
              <>
                Publishing, inventory sync, and order import run against the{" "}
                <strong>built-in demo sandbox</strong> — no real eBay listings are
                created.
              </>
            ) : (
              <>
                Publishing, inventory sync, and order import call the{" "}
                <strong>
                  real eBay {oauth?.env === "PRODUCTION" ? "" : "sandbox "}APIs
                </strong>{" "}
                with your OAuth tokens.
              </>
            )}
          </p>
          {status === "CONNECTED" && !financialsAccess && oauth && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-semibold">Reconnect once to enable actual eBay fee accounting</p>
              <p className="mt-1 text-xs leading-5 text-amber-800">This adds read access to finalized order earnings, transaction fees, advertising fees, refunds, and eBay shipping-label charges.</p>
              <a href="/api/ebay/connect" className="mt-2 inline-flex rounded-lg bg-amber-900 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-800">Reconnect eBay</a>
            </div>
          )}
          <Button
            variant="secondary"
            disabled={disconnecting}
            onClick={() => startDisconnect(async () => void (await disconnectEbay()))}
          >
            {disconnecting ? "Disconnecting…" : "Disconnect"}
          </Button>
        </div>
      ) : (
        <div className="mt-4 space-y-6">
          {oauth && (
            <div className="space-y-2">
              <a
                href="/api/ebay/connect"
                className="inline-flex items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-500"
              >
                Connect eBay account ({oauth.env.toLowerCase()} OAuth)
              </a>
              <p className="text-xs text-slate-500">
                Opens eBay&apos;s consent page; sign in with your{" "}
                {oauth.env === "PRODUCTION" ? "seller" : "sandbox test"} account and
                grant access. Tokens are stored locally and refreshed automatically.
              </p>
              <PasteCallbackForm />
            </div>
          )}

          <form action={formAction} className="space-y-4">
            <p className="text-sm text-slate-600">
              {oauth
                ? "Or use the built-in demo sandbox — a full simulation, no eBay account needed:"
                : "Connect your eBay seller account to publish listings, sync inventory, and import orders."}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="username">Display name for the demo connection</Label>
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
            <Button type="submit" variant={oauth ? "secondary" : "primary"} disabled={pending}>
              {pending ? "Connecting…" : "Connect demo sandbox"}
            </Button>
            {!oauth && (
              <p className="text-xs text-slate-500">
                The demo sandbox simulates eBay end-to-end so you can use the whole
                app without credentials. To connect a real account, set
                EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_RU_NAME in .env — the
                OAuth button appears here once they&apos;re set.
              </p>
            )}
          </form>
        </div>
      )}
    </Card>
  );
}
