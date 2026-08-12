import "server-only";
import { db } from "@/lib/db";
import { decryptToken, encryptToken } from "./crypto";
import { googleEmailConfig } from "./oauth";
import { parseAmazonEmail } from "./parser";
import { resolveMissingAmazonTracking, type TrackingResolutionResult } from "./tracking-resolver";
import { fulfillmentIdentityEvidence, fulfillmentTitleSimilarity } from "./title-match";
import { deliveryAddressFingerprint } from "./address-match";

type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };
type GmailMessage = { id: string; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } & GmailPart };
const AMAZON_EMAIL_SYNC_VERSION = 5;

function decode(data?: string): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function bodies(part?: GmailPart): { html: string; text: string } {
  if (!part) return { html: "", text: "" };
  let html = part.mimeType === "text/html" ? decode(part.body?.data) : "";
  let text = part.mimeType === "text/plain" ? decode(part.body?.data) : "";
  for (const child of part.parts ?? []) {
    const found = bodies(child); html += found.html; text += found.text;
  }
  return { html, text };
}
function header(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}
async function accessToken(userId: string): Promise<string> {
  const connection = await db.amazonEmailConnection.findUnique({ where: { userId } });
  if (!connection?.encryptedRefreshToken && !connection?.encryptedAccessToken) throw new Error("Connect Gmail first");
  if (connection.encryptedAccessToken && connection.accessTokenExpiresAt && connection.accessTokenExpiresAt > new Date(Date.now() + 60_000)) return decryptToken(connection.encryptedAccessToken);
  if (!connection.encryptedRefreshToken) throw new Error("Gmail permission expired; reconnect Gmail");
  const config = googleEmailConfig();
  if (!config) throw new Error("Google email connection is not configured");
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: decryptToken(connection.encryptedRefreshToken), grant_type: "refresh_token" }) });
  if (!response.ok) throw new Error(`Gmail authorization refresh failed (${response.status})`);
  const json = await response.json() as { access_token: string; expires_in: number };
  await db.amazonEmailConnection.update({ where: { userId }, data: { encryptedAccessToken: encryptToken(json.access_token), accessTokenExpiresAt: new Date(Date.now() + json.expires_in * 1000) } });
  return json.access_token;
}

async function gmail<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Gmail lookup failed (${response.status})`);
  return response.json() as Promise<T>;
}

async function reconcile(userId: string): Promise<number> {
  const [items, orders] = await Promise.all([
    db.amazonPurchaseItem.findMany({ where: { purchase: { userId }, matchedOrderId: null }, include: { purchase: true } }),
    db.order.findMany({ where: { userId, amazonPurchaseItem: null }, include: { listing: { include: { product: true } } }, orderBy: { saleDate: "desc" } }),
  ]);
  let matched = 0;
  // Records containing delivery identity must claim their order before a
  // same-ASIN record whose email did not expose a recipient or address.
  const prioritizedItems = [...items].sort((left, right) => {
    const identityCount = (item: typeof items[number]) =>
      (item.purchase.deliveryAddressFingerprint ? 2 : 0) + (item.purchase.recipientName ? 1 : 0);
    const evidenceDifference = identityCount(right) - identityCount(left);
    if (evidenceDifference) return evidenceDifference;
    return (left.purchase.purchasedAt?.getTime() ?? 0) - (right.purchase.purchasedAt?.getTime() ?? 0);
  });
  for (const item of prioritizedItems) {
    let best: { order: typeof orders[number]; score: number; identityStrength: number; reason: string } | null = null;
    for (const order of orders) {
      if (item.purchase.purchasedAt && item.purchase.purchasedAt < new Date(order.saleDate.getTime() - 3 * 86_400_000)) continue;
      const exactAsin = !!item.asin && item.asin.toUpperCase() === order.listing.product.sku.toUpperCase();
      const titleScore = fulfillmentTitleSimilarity(order.listing.title, item.title);
      const identity = fulfillmentIdentityEvidence({
        ebayRecipientName: order.shippingRecipientName,
        amazonRecipientName: item.purchase.recipientName,
        ebayAddressFingerprint: order.shippingAddressFingerprint,
        amazonAddressFingerprint: item.purchase.deliveryAddressFingerprint,
      });
      if (!identity.compatible) continue;
      const score = exactAsin ? 100 : titleScore;
      const candidateDistance = item.purchase.purchasedAt
        ? Math.abs(item.purchase.purchasedAt.getTime() - order.saleDate.getTime())
        : Number.MAX_SAFE_INTEGER;
      const bestDistance = best && item.purchase.purchasedAt
        ? Math.abs(item.purchase.purchasedAt.getTime() - best.order.saleDate.getTime())
        : Number.MAX_SAFE_INTEGER;
      const isBetter = !best
        || identity.strength > best.identityStrength
        || (identity.strength === best.identityStrength && score > best.score)
        || (identity.strength === best.identityStrength && score === best.score && candidateDistance < bestDistance);
      if (score >= 62 && isBetter) {
        best = {
          order,
          score,
          identityStrength: identity.strength,
          reason: exactAsin
            ? `Exact Amazon ASIN matches the listing source${identity.addressMatches ? "; delivery address takes priority" : identity.recipientMatches ? "; shipping recipient takes priority" : ""}`
            : `Amazon delivery item name matches the eBay order title${identity.addressMatches ? "; delivery address takes priority" : identity.recipientMatches ? "; shipping recipient takes priority" : ""}`,
        };
      }
    }
    if (!best) continue;
    const status = item.purchase.status === "DELIVERED" ? "DELIVERED" : item.purchase.status === "SHIPPED" ? "SHIPPED" : "PURCHASED";
    await db.$transaction([
      db.amazonPurchaseItem.update({ where: { id: item.id }, data: { matchedOrderId: best.order.id, matchConfidence: best.score, matchReason: best.reason } }),
      db.order.update({ where: { id: best.order.id }, data: { sourcingStatus: status, amazonMatchedAt: new Date() } }),
    ]);
    const index = orders.findIndex((order) => order.id === best!.order.id); if (index >= 0) orders.splice(index, 1);
    matched++;
  }
  return matched;
}

export async function syncAmazonPurchaseEmails(
  userId: string,
  options: { retryTrackingFailures?: boolean } = {},
): Promise<{ examined: number; imported: number; matched: number; trackingResolution: TrackingResolutionResult }> {
  const token = await accessToken(userId);
  const connection = await db.amazonEmailConnection.findUniqueOrThrow({ where: { userId } });
  const processed = new Set<string>(JSON.parse(connection.processedMessageIdsJson) as string[]);
  let pageToken: string | undefined; const ids: string[] = [];
  do {
    const params = new URLSearchParams({ q: "from:(amazon.com) (subject:(order OR shipped OR delivered OR delivery)) newer_than:365d", maxResults: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await gmail<{ messages?: { id: string }[]; nextPageToken?: string }>(token, `messages?${params}`);
    ids.push(...(page.messages ?? []).map((message) => message.id)); pageToken = page.nextPageToken;
  } while (pageToken && ids.length < 500);
  let imported = 0;
  for (const id of ids) {
    if (processed.has(id) && connection.syncVersion >= AMAZON_EMAIL_SYNC_VERSION) continue;
    const message = await gmail<GmailMessage>(token, `messages/${id}?format=full`);
    const from = header(message, "from").toLowerCase();
    if (!/@(?:[a-z0-9-]+\.)*amazon\.(?:com|ca|co\.uk)>?$/.test(from.replace(/.*</, ""))) continue;
    const content = bodies(message.payload);
    const parsed = parseAmazonEmail({ subject: header(message, "subject"), ...content, sentAt: message.internalDate ? new Date(Number(message.internalDate)) : null });
    if (!parsed) continue;
    const lineBase = parsed.items.reduce((sum, item) => sum + (item.unitPriceCents ?? 0) * item.quantity, 0);
    const prior = await db.amazonPurchase.findUnique({ where: { userId_amazonOrderId: { userId, amazonOrderId: parsed.amazonOrderId } }, include: { items: true } });
    const rank = { ORDERED: 1, SHIPPED: 2, DELIVERED: 3, CANCELLED: 4 } as const;
    const itemData = parsed.items.map((item) => {
      const line = (item.unitPriceCents ?? 0) * item.quantity;
      const ratio = lineBase ? line / lineBase : 1 / Math.max(1, parsed.items.length);
      const usesAllInTotal = item.unitPriceCents === null && parsed.items.length === 1 && parsed.subtotalCents === null && parsed.totalCents !== null;
      const fallbackLine = parsed.items.length === 1 ? (parsed.subtotalCents ?? parsed.totalCents) : null;
      return {
        ...item,
        lineTotalCents: item.unitPriceCents === null ? fallbackLine : line,
        allocatedShippingCents: usesAllInTotal ? 0 : Math.round(parsed.shippingCents * ratio),
        allocatedTaxCents: usesAllInTotal ? 0 : Math.round(parsed.taxCents * ratio),
        allocatedDiscountCents: usesAllInTotal ? 0 : Math.round(parsed.discountCents * ratio),
      };
    });
    if (!prior) {
      await db.amazonPurchase.create({ data: { userId, sourceMessageId: id, amazonOrderId: parsed.amazonOrderId, purchasedAt: parsed.purchasedAt, recipientName: parsed.recipientName, deliveryAddressFingerprint: deliveryAddressFingerprint(parsed.deliveryAddressLine1, parsed.deliveryPostalCode), status: parsed.status, subtotalCents: parsed.subtotalCents, shippingCents: parsed.shippingCents, taxCents: parsed.taxCents, discountCents: parsed.discountCents, totalCents: parsed.totalCents, trackingNumber: parsed.trackingNumber, carrier: parsed.carrier, trackingUrl: parsed.trackingUrl, trackingResolvedAt: parsed.trackingNumber ? new Date() : null, trackingAsinsJson: JSON.stringify(parsed.items.flatMap((item) => item.asin ? [item.asin] : [])), items: { create: itemData } } });
    } else {
      const status = rank[parsed.status] > rank[prior.status as keyof typeof rank] ? parsed.status : prior.status;
      await db.amazonPurchase.update({ where: { id: prior.id }, data: {
        status,
        purchasedAt: prior.purchasedAt ?? parsed.purchasedAt,
        recipientName: parsed.recipientName ?? prior.recipientName,
        deliveryAddressFingerprint: deliveryAddressFingerprint(parsed.deliveryAddressLine1, parsed.deliveryPostalCode) ?? prior.deliveryAddressFingerprint,
        subtotalCents: prior.subtotalCents ?? parsed.subtotalCents,
        shippingCents: prior.shippingCents || parsed.shippingCents,
        taxCents: prior.taxCents || parsed.taxCents,
        discountCents: prior.discountCents || parsed.discountCents,
        trackingNumber: parsed.trackingNumber ?? prior.trackingNumber,
        carrier: parsed.carrier ?? prior.carrier,
        trackingUrl: parsed.trackingUrl ?? prior.trackingUrl,
        ...(parsed.trackingUrl && parsed.trackingUrl !== prior.trackingUrl && {
          trackingLookupError: null,
        }),
        ...((parsed.trackingNumber || parsed.trackingUrl) && parsed.items.length && {
          trackingAsinsJson: JSON.stringify(parsed.items.flatMap((item) => item.asin ? [item.asin] : [])),
        }),
        ...(parsed.trackingNumber && { trackingResolvedAt: new Date(), trackingLookupError: null }),
        totalCents: parsed.totalCents ?? prior.totalCents,
        ...(!prior.items.length && itemData.length ? { items: { create: itemData } } : {}),
      } });
      for (const item of itemData) {
        const existing = prior.items.find((candidate) => item.asin && candidate.asin === item.asin)
          ?? (prior.items.length === 1 && itemData.length === 1 ? prior.items[0] : null);
        if (!existing) continue;
        await db.amazonPurchaseItem.update({ where: { id: existing.id }, data: {
          title: item.title || existing.title,
          quantity: item.quantity || existing.quantity,
          unitPriceCents: existing.unitPriceCents ?? item.unitPriceCents,
          lineTotalCents: existing.lineTotalCents ?? item.lineTotalCents,
          allocatedShippingCents: existing.allocatedShippingCents || item.allocatedShippingCents,
          allocatedTaxCents: existing.allocatedTaxCents || item.allocatedTaxCents,
          allocatedDiscountCents: existing.allocatedDiscountCents || item.allocatedDiscountCents,
          amazonUrl: existing.amazonUrl ?? item.amazonUrl,
        } });
      }
      await db.order.updateMany({ where: { amazonPurchaseItem: { purchaseId: prior.id } }, data: { sourcingStatus: status === "DELIVERED" ? "DELIVERED" : status === "SHIPPED" ? "SHIPPED" : status === "CANCELLED" ? "CANCELLED" : "PURCHASED" } });
    }
    processed.add(id);
    imported++;
  }
  const matched = await reconcile(userId);
  const trackingResolution = await resolveMissingAmazonTracking(userId, {
    retryFailed: options.retryTrackingFailures,
  });
  await db.amazonEmailConnection.update({ where: { userId }, data: { lastSyncedAt: new Date(), lastSyncError: null, processedMessageIdsJson: JSON.stringify([...processed].slice(-1000)), syncVersion: AMAZON_EMAIL_SYNC_VERSION } });
  return { examined: ids.length, imported, matched, trackingResolution };
}

export function actualAmazonCost(item: { lineTotalCents: number | null; allocatedShippingCents: number; allocatedTaxCents: number; allocatedDiscountCents: number }): number | null {
  if (item.lineTotalCents === null) return null;
  return item.lineTotalCents + item.allocatedShippingCents + item.allocatedTaxCents - item.allocatedDiscountCents;
}
