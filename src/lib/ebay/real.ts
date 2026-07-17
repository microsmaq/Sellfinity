// Real eBay client over the Sell APIs (sandbox or production per EBAY_ENV).
// Listing model: SKU-based Inventory API — inventory item + offer + publish.
// First publish per account bootstraps the required merchant location and
// business policies (free flat-rate shipping, 30-day returns, managed
// payments) if the seller has none.

import { db } from "@/lib/db";
import {
  EbayApiError,
  type CreateListingInput,
  type EbayClient,
  type ListingUpdate,
  type RemoteListing,
  type RemoteOrder,
} from "./client";
import {
  appAccessToken,
  ebayEnvConfig,
  freshAccessToken,
  type EbayEnvConfig,
} from "./oauth";
import { fitEbayDescription } from "./description";

const MARKETPLACE = "EBAY_US";
const LOCATION_KEY = "sellfinity-primary";
const POLICY_PREFIX = "Sellfinity default";

function xmlField(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`))?.[1] ?? null;
}

function decodeTradingXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function escapeTradingXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Recover the immutable Inventory SKU that eBay attached to a listing. */
export function inventorySkuFromTradingItem(xml: string): string | null {
  const sku = xmlField(xml, "SKU");
  return sku ? decodeTradingXml(sku) : null;
}

/** Parse one GetMyeBaySelling <Item> block into a RemoteListing. Exported
 * for tests. */
export function parseTradingItem(block: string): RemoteListing | null {
  const ebayListingId = xmlField(block, "ItemID");
  const title = xmlField(block, "Title");
  const price = xmlField(block, "CurrentPrice") ?? xmlField(block, "BuyItNowPrice");
  if (!ebayListingId || !title || !price) return null;
  const quantityRaw =
    xmlField(block, "QuantityAvailable") ?? xmlField(block, "Quantity");
  const startTimeRaw = xmlField(block, "StartTime");
  const startTime = startTimeRaw ? new Date(startTimeRaw) : null;
  return {
    ebayListingId,
    // Trading XML escapes entities; unescape the common ones.
    title: decodeTradingXml(title),
    priceCents: Math.round(parseFloat(price) * 100),
    url: xmlField(block, "ViewItemURL") ?? `https://www.ebay.com/itm/${ebayListingId}`,
    imageUrl: xmlField(block, "GalleryURL"),
    quantity: quantityRaw !== null ? parseInt(quantityRaw, 10) : null,
    listingDate: startTime && !Number.isNaN(startTime.getTime()) ? startTime : null,
  };
}

type InventoryOfferSummary = {
  offerId?: string;
  listing?: { listingId?: string };
};

const EBAY_GET_MAX_ATTEMPTS = 3;

/** eBay occasionally returns its generic 25001 system error for otherwise
 * valid reads. Retrying reads is safe; writes are deliberately never retried
 * here because some eBay write endpoints are not idempotent. */
export function shouldRetryEbayRequest(method: string, status: number): boolean {
  return method.toUpperCase() === "GET" && (status === 429 || status >= 500);
}

/** Honor a short Retry-After response when supplied, otherwise use a small
 * exponential backoff. The cap keeps one transient eBay failure from holding
 * a server action open for too long. */
export function ebayRetryDelayMs(
  retryAfter: string | null,
  failedAttempt: number,
): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, 5_000);
    }
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) {
      return Math.min(Math.max(dateMs - Date.now(), 0), 5_000);
    }
  }
  return Math.min(400 * 2 ** Math.max(failedAttempt - 1, 0), 2_000);
}

/** Select only the Inventory offer actually published as this eBay listing.
 * A listing's locally assigned Amazon product/SKU can change after source
 * repair, so taking the first offer for that SKU can target another listing. */
export function inventoryOfferForListing(
  offers: InventoryOfferSummary[] | undefined,
  ebayListingId: string,
): InventoryOfferSummary | null {
  return offers?.find((offer) => offer.listing?.listingId === ebayListingId) ?? null;
}

export class RealEbayClient implements EbayClient {
  private policiesPromise?: Promise<{
    fulfillmentPolicyId: string;
    paymentPolicyId: string;
    returnPolicyId: string;
  }>;

  constructor(
    private userId: string,
    private config: EbayEnvConfig = ebayEnvConfig()!,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    // Taxonomy and other app-level APIs reject user tokens.
    auth: "user" | "app" = "user",
  ): Promise<T> {
    const token =
      auth === "app"
        ? await appAccessToken(this.config)
        : await freshAccessToken(this.config, this.userId);
    const maxAttempts = method.toUpperCase() === "GET" ? EBAY_GET_MAX_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetch(`${this.config.apiHost}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Language": "en-US",
          Accept: "application/json",
          "Accept-Language": "en-US",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        if (shouldRetryEbayRequest(method, res.status) && attempt < maxAttempts) {
          await new Promise((resolve) =>
            setTimeout(resolve, ebayRetryDelayMs(res.headers.get("retry-after"), attempt)),
          );
          continue;
        }
        const retryNote =
          shouldRetryEbayRequest(method, res.status) && maxAttempts > 1
            ? ` after ${maxAttempts} attempts`
            : "";
        throw new EbayApiError(
          `eBay ${method} ${path} failed (${res.status})${retryNote}: ${text.slice(0, 500)}`,
        );
      }
      if (res.status === 204 || res.headers.get("content-length") === "0") {
        return undefined as T;
      }
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    throw new EbayApiError(`eBay ${method} ${path} failed after ${maxAttempts} attempts`);
  }

  /** Swallows "already exists" errors so bootstrap calls are idempotent. */
  private async ensure(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      if (e instanceof EbayApiError && /already|\b25801\b/i.test(e.message)) return;
      throw e;
    }
  }

  private async ensureLocation(): Promise<void> {
    await this.ensure(() =>
      this.request("POST", `/sell/inventory/v1/location/${LOCATION_KEY}`, {
        location: {
          address: {
            city: "San Jose",
            stateOrProvince: "CA",
            postalCode: "95125",
            country: "US",
          },
        },
        name: "Sellfinity primary location",
        merchantLocationStatus: "ENABLED",
        locationTypes: ["WAREHOUSE"],
      }),
    );
  }

  private ensurePolicies() {
    this.policiesPromise ??= (async () => {
      // Sellers (sandbox test users especially) may not be enrolled in
      // business policies yet — error 20403 on any policy call. Re-opting-in
      // returns an unhelpful 409, so check enrollment first.
      const enrolled = await this.request<{ programs?: { programType: string }[] }>(
        "GET",
        "/sell/account/v1/program/get_opted_in_programs",
      );
      if (
        !enrolled.programs?.some((p) => p.programType === "SELLING_POLICY_MANAGEMENT")
      ) {
        await this.request("POST", "/sell/account/v1/program/opt_in", {
          programType: "SELLING_POLICY_MANAGEMENT",
        });
      }

      const q = `marketplace_id=${MARKETPLACE}`;

      const [fulfillment, payment, returns] = await Promise.all([
        this.request<{ fulfillmentPolicies?: { fulfillmentPolicyId: string }[] }>("GET", `/sell/account/v1/fulfillment_policy?${q}`),
        this.request<{ paymentPolicies?: { paymentPolicyId: string }[] }>("GET", `/sell/account/v1/payment_policy?${q}`),
        this.request<{ returnPolicies?: { returnPolicyId: string }[] }>("GET", `/sell/account/v1/return_policy?${q}`),
      ]);

      const categoryTypes = [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }];

      let fulfillmentPolicyId = fulfillment.fulfillmentPolicies?.[0]?.fulfillmentPolicyId;
      if (!fulfillmentPolicyId) {
        const created = await this.request<{ fulfillmentPolicyId: string }>(
          "POST",
          "/sell/account/v1/fulfillment_policy",
          {
            name: `${POLICY_PREFIX} shipping`,
            marketplaceId: MARKETPLACE,
            categoryTypes,
            handlingTime: { value: 1, unit: "DAY" },
            shippingOptions: [
              {
                costType: "FLAT_RATE",
                optionType: "DOMESTIC",
                shippingServices: [
                  {
                    // Trading-API-style code ("USPSPriority", not
                    // "USPSPriorityMail") — the Account API validates against
                    // that enum, and sandbox rejects newer codes like
                    // USPSGroundAdvantage.
                    shippingCarrierCode: "USPS",
                    shippingServiceCode: "USPSPriority",
                    freeShipping: true,
                  },
                ],
              },
            ],
          },
        );
        fulfillmentPolicyId = created.fulfillmentPolicyId;
      }

      let paymentPolicyId = payment.paymentPolicies?.[0]?.paymentPolicyId;
      if (!paymentPolicyId) {
        const created = await this.request<{ paymentPolicyId: string }>(
          "POST",
          "/sell/account/v1/payment_policy",
          {
            name: `${POLICY_PREFIX} payments`,
            marketplaceId: MARKETPLACE,
            categoryTypes,
          },
        );
        paymentPolicyId = created.paymentPolicyId;
      }

      let returnPolicyId = returns.returnPolicies?.[0]?.returnPolicyId;
      if (!returnPolicyId) {
        const created = await this.request<{ returnPolicyId: string }>(
          "POST",
          "/sell/account/v1/return_policy",
          {
            name: `${POLICY_PREFIX} returns`,
            marketplaceId: MARKETPLACE,
            categoryTypes,
            returnsAccepted: true,
            returnPeriod: { value: 30, unit: "DAY" },
            refundMethod: "MONEY_BACK",
            returnShippingCostPayer: "SELLER",
          },
        );
        returnPolicyId = created.returnPolicyId;
      }

      return { fulfillmentPolicyId, paymentPolicyId, returnPolicyId };
    })();
    return this.policiesPromise;
  }

  private async suggestCategoryId(title: string): Promise<string> {
    const res = await this.request<{
      categorySuggestions?: { category: { categoryId: string } }[];
    }>(
      "GET",
      `/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(title)}`,
      undefined,
      "app",
    );
    const id = res.categorySuggestions?.[0]?.category.categoryId;
    if (!id) throw new EbayApiError(`eBay could not suggest a category for "${title}"`);
    return id;
  }

  /**
   * Required item specifics for a category, filled with the standard
   * defaults sellers use when the data isn't known ("Unbranded" brand,
   * "Does Not Apply" for the rest).
   */
  private async requiredAspects(categoryId: string): Promise<Record<string, string[]>> {
    const res = await this.request<{
      aspects?: {
        localizedAspectName: string;
        aspectConstraint?: { aspectRequired?: boolean };
      }[];
    }>(
      "GET",
      `/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${categoryId}`,
      undefined,
      "app",
    );
    const aspects: Record<string, string[]> = {};
    for (const aspect of res.aspects ?? []) {
      if (!aspect.aspectConstraint?.aspectRequired) continue;
      const name = aspect.localizedAspectName;
      aspects[name] = [name.toLowerCase() === "brand" ? "Unbranded" : "Does Not Apply"];
    }
    return aspects;
  }

  async createListing(input: CreateListingInput): Promise<{ ebayListingId: string }> {
    await this.ensureLocation();
    const [policies, categoryId] = await Promise.all([
      this.ensurePolicies(),
      this.suggestCategoryId(input.title),
    ]);
    const aspects = await this.requiredAspects(categoryId);
    const description = fitEbayDescription(input.description);

    await this.request("PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(input.sku)}`, {
      product: {
        title: input.title,
        description,
        imageUrls: input.imageUrls.slice(0, 12),
        aspects,
      },
      condition: "NEW",
      availability: { shipToLocationAvailability: { quantity: input.quantity } },
    });

    const offerBody = {
      sku: input.sku,
      marketplaceId: MARKETPLACE,
      format: "FIXED_PRICE",
      availableQuantity: input.quantity,
      categoryId,
      listingDescription: description,
      listingPolicies: policies,
      pricingSummary: {
        price: { value: (input.priceCents / 100).toFixed(2), currency: "USD" },
      },
      merchantLocationKey: LOCATION_KEY,
    };

    let offerId: string;
    try {
      const offer = await this.request<{ offerId: string }>(
        "POST",
        "/sell/inventory/v1/offer",
        offerBody,
      );
      offerId = offer.offerId;
    } catch (e) {
      // A previous attempt that died between offer creation and publish
      // leaves an unpublished offer behind; adopt it instead of failing.
      if (!(e instanceof EbayApiError) || !/already exists/i.test(e.message)) throw e;
      const existing = await this.request<{ offers?: { offerId: string }[] }>(
        "GET",
        `/sell/inventory/v1/offer?sku=${encodeURIComponent(input.sku)}&marketplace_id=${MARKETPLACE}`,
      );
      const existingId = existing.offers?.[0]?.offerId;
      if (!existingId) throw e;
      offerId = existingId;
      await this.request("PUT", `/sell/inventory/v1/offer/${offerId}`, offerBody);
    }

    const published = await this.request<{ listingId: string }>(
      "POST",
      `/sell/inventory/v1/offer/${offerId}/publish`,
    );
    return { ebayListingId: published.listingId };
  }

  /** The offer behind one of our published listings; null when the listing
   * wasn't created through the Inventory API (imported/foreign listings). */
  private async offerIdFor(
    ebayListingId: string,
  ): Promise<{ offerId: string; sku: string } | null> {
    const listing = await db.listing.findFirst({
      where: { userId: this.userId, ebayListingId },
      include: { product: { select: { sku: true } } },
    });
    if (!listing) return null;
    const findOffer = async (sku: string) => {
      let res: { offers?: InventoryOfferSummary[] };
      try {
        res = await this.request<{ offers?: InventoryOfferSummary[] }>(
          "GET",
          `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${MARKETPLACE}`,
        );
      } catch (e) {
        if (e instanceof EbayApiError && /\(404\)|25713/.test(e.message)) return null;
        throw e;
      }
      const offerId = inventoryOfferForListing(res.offers, ebayListingId)?.offerId;
      return offerId ? { offerId, sku } : null;
    };

    // Fast path for listings whose local source product/SKU never changed.
    const currentSkuOffer = await findOffer(listing.product.sku);
    if (currentSkuOffer) return currentSkuOffer;

    // Source repair can reassign listing.product to a different Amazon ASIN,
    // but eBay's Inventory SKU is immutable. GetItem is still allowed to read
    // an Inventory-managed listing and returns that original SKU; use it to
    // resolve the correct offer instead of attempting a Trading API revision.
    const itemXml = await this.tradingRequest(
      "GetItem",
      `<ItemID>${ebayListingId}</ItemID><DetailLevel>ReturnAll</DetailLevel>`,
    );
    const originalSku = inventorySkuFromTradingItem(itemXml);
    if (!originalSku || originalSku === listing.product.sku) return null;
    return findOffer(originalSku);
  }

  /** Trading API call (XML) — used for the seller's full listing inventory
   * and for revising/ending listings not created through the Inventory API.
   * Returns the raw response XML on success (Ack Success/Warning). */
  private async tradingRequest(callName: string, innerXml: string): Promise<string> {
    const token = await freshAccessToken(this.config, this.userId);
    const body = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
${innerXml}
</${callName}Request>`;
    const res = await fetch(`${this.config.apiHost}/ws/api.dll`, {
      method: "POST",
      headers: {
        "X-EBAY-API-CALL-NAME": callName,
        "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-IAF-TOKEN": token,
        "Content-Type": "text/xml",
      },
      body,
    });
    const text = await res.text();
    const ack = text.match(/<Ack>([^<]+)<\/Ack>/)?.[1];
    if (!res.ok || ack === "Failure") {
      const message =
        text.match(/<LongMessage>([^<]+)<\/LongMessage>/)?.[1] ??
        `HTTP ${res.status}`;
      throw new EbayApiError(`eBay ${callName} failed: ${message.slice(0, 300)}`);
    }
    return text;
  }

  async updateListing(ebayListingId: string, update: ListingUpdate): Promise<void> {
    const offer = await this.offerIdFor(ebayListingId);
    if (!offer) {
      // Foreign/imported listing: revise via Trading API.
      const fields = [
        `<ItemID>${ebayListingId}</ItemID>`,
        update.priceCents !== undefined
          ? `<StartPrice>${(update.priceCents / 100).toFixed(2)}</StartPrice>`
          : "",
        update.quantity !== undefined
          ? `<Quantity>${update.quantity}</Quantity>`
          : "",
        update.title !== undefined
          ? `<Title>${escapeTradingXml(update.title)}</Title>`
          : "",
        update.description !== undefined
          ? `<Description>${escapeTradingXml(fitEbayDescription(update.description))}</Description>`
          : "",
        update.imageUrls !== undefined
          ? `<PictureDetails>${update.imageUrls
              .slice(0, 12)
              .map((url) => `<PictureURL>${escapeTradingXml(url)}</PictureURL>`)
              .join("")}</PictureDetails>`
          : "",
      ].join("");
      await this.tradingRequest("ReviseFixedPriceItem", `<Item>${fields}</Item>`);
      return;
    }
    if (
      update.title !== undefined ||
      update.description !== undefined ||
      update.imageUrls !== undefined
    ) {
      type InventoryItemRecord = {
        product?: Record<string, unknown>;
        condition?: string;
        conditionDescription?: string;
        availability?: Record<string, unknown>;
        packageWeightAndSize?: Record<string, unknown>;
      };
      const current = await this.request<InventoryItemRecord>(
        "GET",
        `/sell/inventory/v1/inventory_item/${encodeURIComponent(offer.sku)}`,
      );
      await this.request(
        "PUT",
        `/sell/inventory/v1/inventory_item/${encodeURIComponent(offer.sku)}`,
        {
          product: {
            ...(current.product ?? {}),
            ...(update.title !== undefined && { title: update.title }),
            ...(update.description !== undefined && {
              description: fitEbayDescription(update.description),
            }),
            ...(update.imageUrls !== undefined && { imageUrls: update.imageUrls.slice(0, 12) }),
          },
          ...(current.condition && { condition: current.condition }),
          ...(current.conditionDescription && {
            conditionDescription: current.conditionDescription,
          }),
          ...(current.availability && { availability: current.availability }),
          ...(current.packageWeightAndSize && {
            packageWeightAndSize: current.packageWeightAndSize,
          }),
        },
      );
    }
    if (update.priceCents !== undefined || update.quantity !== undefined) {
      await this.request("POST", "/sell/inventory/v1/bulk_update_price_quantity", {
        requests: [
          {
            sku: offer.sku,
            ...(update.quantity !== undefined && {
              shipToLocationAvailability: { quantity: update.quantity },
            }),
            offers: [
              {
                offerId: offer.offerId,
                ...(update.quantity !== undefined && { availableQuantity: update.quantity }),
                ...(update.priceCents !== undefined && {
                  price: { value: (update.priceCents / 100).toFixed(2), currency: "USD" },
                }),
              },
            ],
          },
        ],
      });
    }
  }

  async endListing(ebayListingId: string): Promise<void> {
    const offer = await this.offerIdFor(ebayListingId);
    if (!offer) {
      await this.tradingRequest(
        "EndFixedPriceItem",
        `<ItemID>${ebayListingId}</ItemID><EndingReason>NotAvailable</EndingReason>`,
      );
      return;
    }
    await this.request("POST", `/sell/inventory/v1/offer/${offer.offerId}/withdraw`);
  }

  async getSellerListings(): Promise<RemoteListing[]> {
    const listings: RemoteListing[] = [];
    for (let page = 1; page <= 10; page++) {
      const xml = await this.tradingRequest(
        "GetMyeBaySelling",
        `<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList><DetailLevel>ReturnAll</DetailLevel>`,
      );
      const itemBlocks = xml.match(/<Item>[\s\S]*?<\/Item>/g) ?? [];
      for (const block of itemBlocks) {
        const parsed = parseTradingItem(block);
        if (parsed) listings.push(parsed);
      }
      const totalPages = parseInt(
        xml.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1] ?? "1",
        10,
      );
      if (page >= totalPages || itemBlocks.length === 0) break;
    }
    return listings;
  }

  async getOrders(_userId: string, since: Date): Promise<RemoteOrder[]> {
    type FulfillmentOrder = {
      orderId: string;
      creationDate: string;
      buyer?: { username?: string };
      lineItems?: {
        lineItemId: string;
        legacyItemId?: string;
        quantity: number;
        lineItemCost?: { value?: string };
        deliveryCost?: { shippingCost?: { value?: string } };
      }[];
    };
    const filter = encodeURIComponent(`creationdate:[${since.toISOString().replace(/\.\d{3}Z$/, ".000Z")}..]`);
    const orders: RemoteOrder[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.request<{ orders?: FulfillmentOrder[]; total?: number }>(
        "GET",
        `/sell/fulfillment/v1/order?filter=${filter}&limit=100&offset=${offset}`,
      );
      for (const order of page.orders ?? []) {
        for (const item of order.lineItems ?? []) {
          if (!item.legacyItemId) continue;
          const totalCents = Math.round(parseFloat(item.lineItemCost?.value ?? "0") * 100);
          orders.push({
            ebayOrderId: `${order.orderId}-${item.lineItemId}`,
            ebayListingId: item.legacyItemId,
            quantity: item.quantity,
            salePriceCents: Math.round(totalCents / Math.max(1, item.quantity)),
            shippingChargedCents: Math.round(
              parseFloat(item.deliveryCost?.shippingCost?.value ?? "0") * 100,
            ),
            buyerUsername: order.buyer?.username ?? "unknown",
            saleDate: new Date(order.creationDate),
          });
        }
      }
      offset += 100;
      if (!page.orders || page.orders.length < 100) break;
    }
    return orders;
  }
}
