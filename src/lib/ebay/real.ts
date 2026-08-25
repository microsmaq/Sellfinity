// Real eBay client over the Sell APIs (sandbox or production per EBAY_ENV).
// Listing model: SKU-based Inventory API — inventory item + offer + publish.
// First publish per account bootstraps the required merchant location and
// business policies (free flat-rate shipping, 30-day returns, managed
// payments) if the seller has none.

import { db } from "@/lib/db";
import {
  EBAY_US_IDENTIFIER_UNAVAILABLE,
  ebayProductBrand,
  ebayProductMpn,
  requiredEbayAspectValue,
} from "./product-details";
import {
  EbayApiError,
  type CreateListingInput,
  type EbayClient,
  type ListingUpdate,
  type RemoteListing,
  type ListingTrafficMetric,
  type ListingTrafficDayMetric,
  type RemoteOrder,
  type RemoteOrderFinancials,
  type RemoteFulfillmentOrder,
  type ShippingFulfillmentInput,
} from "./client";
import { parseOrderFinancials } from "./order-financials";
import {
  appAccessToken,
  ebayEnvConfig,
  freshAccessToken,
  type EbayEnvConfig,
} from "./oauth";
import { fitEbayDescription } from "./description";
import { ebayImportedOrderState } from "@/lib/orders/ebay-state";
import { isInvalidEbayQuantityError, isMissingEbayInventoryProductError, isTransientEbaySystemError } from "./errors";
import { parseImageUrls } from "@/lib/types";

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
  private buyerPaidPolicyPromise?: Promise<string>;

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
          res.status,
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
        this.request<{ fulfillmentPolicies?: { fulfillmentPolicyId: string; name?: string }[] }>("GET", `/sell/account/v1/fulfillment_policy?${q}`),
        this.request<{ paymentPolicies?: { paymentPolicyId: string }[] }>("GET", `/sell/account/v1/payment_policy?${q}`),
        this.request<{ returnPolicies?: { returnPolicyId: string }[] }>("GET", `/sell/account/v1/return_policy?${q}`),
      ]);

      const categoryTypes = [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }];

      let fulfillmentPolicyId = fulfillment.fulfillmentPolicies?.find((policy) => policy.name === `${POLICY_PREFIX} shipping`)?.fulfillmentPolicyId;
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

  /** Use one non-free policy and override its flat rate on each Inventory
   * offer. This is eBay's supported per-listing mechanism and avoids creating
   * hundreds of business policies for cent-level shipping amounts. */
  private ensureShippingPolicy(buyerShippingCents: number): Promise<string> {
    const cents = Math.max(0, Math.min(700, Math.round(buyerShippingCents)));
    if (cents === 0) return this.ensurePolicies().then((policies) => policies.fulfillmentPolicyId);
    this.buyerPaidPolicyPromise ??= (async () => {
      const q = `marketplace_id=${MARKETPLACE}`;
      const name = `${POLICY_PREFIX} buyer-paid shipping`;
      const policies = await this.request<{ fulfillmentPolicies?: Array<{ fulfillmentPolicyId: string; name?: string }> }>("GET", `/sell/account/v1/fulfillment_policy?${q}`);
      const matched = policies.fulfillmentPolicies?.find((policy) => policy.name === name);
      if (matched) return matched.fulfillmentPolicyId;
      const created = await this.request<{ fulfillmentPolicyId: string }>("POST", "/sell/account/v1/fulfillment_policy", {
        name,
        marketplaceId: MARKETPLACE,
        categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }],
        handlingTime: { value: 1, unit: "DAY" },
        shippingOptions: [{
          costType: "FLAT_RATE",
          optionType: "DOMESTIC",
          shippingServices: [{
            shippingCarrierCode: "USPS",
            shippingServiceCode: "USPSPriority",
            freeShipping: false,
            shippingCost: { value: "0.01", currency: "USD" },
            additionalShippingCost: { value: "0.01", currency: "USD" },
          }],
        }],
      });
      return created.fulfillmentPolicyId;
    })();
    return this.buyerPaidPolicyPromise;
  }

  private shippingCostOverrides(buyerShippingCents: number) {
    const cents = Math.max(0, Math.min(700, Math.round(buyerShippingCents)));
    if (cents === 0) return undefined;
    const amount = { value: (cents / 100).toFixed(2), currency: "USD" };
    return [{ priority: 1, shippingServiceType: "DOMESTIC", shippingCost: amount, additionalShippingCost: amount }];
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
   * "Does not apply" for the rest). eBay's unavailable-identifier text is
   * marketplace-specific and case-sensitive; this client publishes to the
   * United States marketplace.
   */
  private async requiredAspects(
    categoryId: string,
    brand?: string,
  ): Promise<Record<string, string[]>> {
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
      aspects[name] = [requiredEbayAspectValue(name, brand)];
    }
    return aspects;
  }

  async createListing(input: CreateListingInput): Promise<{ ebayListingId: string }> {
    await this.ensureLocation();
    const [policies, categoryId] = await Promise.all([
      this.ensurePolicies(),
      this.suggestCategoryId(input.title),
    ]);
    const aspects = await this.requiredAspects(categoryId, input.brand);
    const buyerShippingCents = input.buyerShippingCents ?? 0;
    const listingPolicies = {
      ...policies,
      fulfillmentPolicyId: await this.ensureShippingPolicy(buyerShippingCents),
      ...(buyerShippingCents > 0 && { shippingCostOverrides: this.shippingCostOverrides(buyerShippingCents) }),
    };
    const description = fitEbayDescription(input.description);
    const brand = ebayProductBrand(input.brand);
    const mpn = ebayProductMpn();

    await this.request("PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(input.sku)}`, {
      product: {
        title: input.title,
        description,
        imageUrls: input.imageUrls.slice(0, 12),
        aspects,
        brand,
        // Some eBay categories validate Brand/MPN as a paired, dedicated
        // product identifier even when both values also exist in aspects.
        mpn,
        // Amazon does not reliably expose GTINs. eBay US explicitly accepts
        // this substitute when a category requires UPC but the product's UPC
        // is unavailable. This must be sent in the dedicated Product field;
        // an identically named item aspect alone does not satisfy publishing.
        upc: [EBAY_US_IDENTIFIER_UNAVAILABLE],
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
      listingPolicies,
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
        update.buyerShippingCents !== undefined
          ? `<ShippingDetails><ShippingType>Flat</ShippingType><ShippingServiceOptions><ShippingService>USPSPriority</ShippingService><ShippingServicePriority>1</ShippingServicePriority><ShippingServiceCost currencyID="USD">${(update.buyerShippingCents / 100).toFixed(2)}</ShippingServiceCost><FreeShipping>${update.buyerShippingCents === 0}</FreeShipping></ShippingServiceOptions></ShippingDetails>`
          : "",
      ].join("");
      await this.tradingRequest("ReviseFixedPriceItem", `<Item>${fields}</Item>`);
      return;
    }
    type InventoryItemRecord = {
      product?: Record<string, unknown>;
      condition?: string;
      conditionDescription?: string;
      availability?: Record<string, unknown> & {
        shipToLocationAvailability?: Record<string, unknown> & { quantity?: number };
      };
      packageWeightAndSize?: Record<string, unknown>;
    };
    const getInventoryItem = () => this.request<InventoryItemRecord>(
      "GET",
      `/sell/inventory/v1/inventory_item/${encodeURIComponent(offer.sku)}`,
    );
    const putInventoryItem = (current: InventoryItemRecord, quantity?: number) => this.request(
      "PUT",
      `/sell/inventory/v1/inventory_item/${encodeURIComponent(offer.sku)}`,
      {
        product: current.product ?? {},
        ...(current.condition && { condition: current.condition }),
        ...(current.conditionDescription && { conditionDescription: current.conditionDescription }),
        ...(current.availability && { availability: current.availability }),
        ...(quantity !== undefined && {
          availability: {
            ...(current.availability ?? {}),
            shipToLocationAvailability: {
              ...(current.availability?.shipToLocationAvailability ?? {}),
              quantity,
            },
          },
        }),
        ...(current.packageWeightAndSize && { packageWeightAndSize: current.packageWeightAndSize }),
      },
    );
    const repairInvalidQuantity = async (): Promise<number> => {
      const current = await getInventoryItem();
      const existingQuantity = current.availability?.shipToLocationAvailability?.quantity;
      const repairedQuantity = update.quantity !== undefined && update.quantity > 0
        ? Math.round(update.quantity)
        : typeof existingQuantity === "number" && existingQuantity > 0
          ? Math.round(existingQuantity)
          : 1;
      await putInventoryItem(current, repairedQuantity);
      await db.listing.updateMany({
        where: { userId: this.userId, ebayListingId, status: "ACTIVE" },
        data: { quantity: repairedQuantity },
      });
      return repairedQuantity;
    };
    const rebuildMissingInventoryProduct = async (categoryId?: string): Promise<number> => {
      const local = await db.listing.findFirst({
        where: { userId: this.userId, ebayListingId, status: "ACTIVE" },
        include: { product: true },
      });
      if (!local) throw new EbayApiError("The local listing needed to rebuild the eBay inventory product was not found.");
      const quantity = update.quantity !== undefined && update.quantity > 0
        ? Math.round(update.quantity)
        : Math.max(1, local.quantity);
      const brand = ebayProductBrand(local.product.brand);
      const aspects = categoryId ? await this.requiredAspects(categoryId, local.product.brand) : {};
      await this.request("PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(offer.sku)}`, {
        product: {
          title: update.title ?? local.title,
          description: fitEbayDescription(update.description ?? local.description),
          imageUrls: (update.imageUrls ?? parseImageUrls(local.imageUrlsJson)).slice(0, 12),
          aspects,
          brand,
          mpn: ebayProductMpn(),
          upc: [EBAY_US_IDENTIFIER_UNAVAILABLE],
        },
        condition: "NEW",
        availability: { shipToLocationAvailability: { quantity } },
      });
      await db.listing.update({ where: { id: local.id }, data: { quantity } });
      return quantity;
    };
    const runIdempotentUpdate = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!isTransientEbaySystemError(message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 600));
        await operation();
      }
    };
    if (update.buyerShippingCents !== undefined) {
      const buyerShippingCents = update.buyerShippingCents;
      const fulfillmentPolicyId = await this.ensureShippingPolicy(buyerShippingCents);
      const current = await this.request<Record<string, unknown> & { listingPolicies?: Record<string, unknown> }>(
        "GET",
        `/sell/inventory/v1/offer/${offer.offerId}`,
      );
      const writable = { ...current };
      delete writable.offerId;
      delete writable.listing;
      delete writable.status;
      const updateOffer = (repairedQuantity?: number) => this.request("PUT", `/sell/inventory/v1/offer/${offer.offerId}`, {
          ...writable,
          ...(repairedQuantity !== undefined && { availableQuantity: repairedQuantity }),
          ...(update.description !== undefined && { listingDescription: fitEbayDescription(update.description) }),
          listingPolicies: {
            ...(current.listingPolicies ?? {}),
            fulfillmentPolicyId,
            shippingCostOverrides: this.shippingCostOverrides(buyerShippingCents),
          },
        });
      try {
        await runIdempotentUpdate(updateOffer);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!isInvalidEbayQuantityError(message) && !isMissingEbayInventoryProductError(message)) throw error;
        const repairedQuantity = isMissingEbayInventoryProductError(message)
          ? await rebuildMissingInventoryProduct(typeof current.categoryId === "string" ? current.categoryId : undefined)
          : await repairInvalidQuantity();
        await runIdempotentUpdate(() => updateOffer(repairedQuantity));
      }
    }
    // Inventory API listings keep the public listing description on the
    // offer as listingDescription. Updating only product.description changes
    // the inventory record but can leave the live eBay page unchanged.
    if (update.description !== undefined && update.buyerShippingCents === undefined) {
      const currentOffer = await this.request<Record<string, unknown>>(
        "GET",
        `/sell/inventory/v1/offer/${offer.offerId}`,
      );
      const writableOffer = { ...currentOffer };
      delete writableOffer.offerId;
      delete writableOffer.listing;
      delete writableOffer.status;
      const updateDescription = (repairedQuantity?: number) => this.request(
        "PUT",
        `/sell/inventory/v1/offer/${offer.offerId}`,
        {
          ...writableOffer,
          ...(repairedQuantity !== undefined && { availableQuantity: repairedQuantity }),
          listingDescription: fitEbayDescription(update.description!),
        },
      );
      try {
        await runIdempotentUpdate(updateDescription);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!isInvalidEbayQuantityError(message) && !isMissingEbayInventoryProductError(message)) throw error;
        const repairedQuantity = isMissingEbayInventoryProductError(message)
          ? await rebuildMissingInventoryProduct(typeof currentOffer.categoryId === "string" ? currentOffer.categoryId : undefined)
          : await repairInvalidQuantity();
        await runIdempotentUpdate(() => updateDescription(repairedQuantity));
      }
    }
    if (
      update.title !== undefined ||
      update.description !== undefined ||
      update.imageUrls !== undefined
    ) {
      const current = await getInventoryItem();
      await putInventoryItem({
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
        });
    }
    if (update.priceCents !== undefined || update.quantity !== undefined) {
      const bulkUpdate = (repairedQuantity?: number) => this.request("POST", "/sell/inventory/v1/bulk_update_price_quantity", {
        requests: [
          {
            sku: offer.sku,
            ...((update.quantity !== undefined || repairedQuantity !== undefined) && {
              shipToLocationAvailability: { quantity: repairedQuantity ?? update.quantity },
            }),
            offers: [
              {
                offerId: offer.offerId,
                ...((update.quantity !== undefined || repairedQuantity !== undefined) && { availableQuantity: repairedQuantity ?? update.quantity }),
                ...(update.priceCents !== undefined && {
                  price: { value: (update.priceCents / 100).toFixed(2), currency: "USD" },
                }),
              },
            ],
          },
        ],
      });
      try {
        await runIdempotentUpdate(bulkUpdate);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!isInvalidEbayQuantityError(message) && !isMissingEbayInventoryProductError(message)) throw error;
        let repairedQuantity: number;
        if (isMissingEbayInventoryProductError(message)) {
          const currentOffer = await this.request<Record<string, unknown>>("GET", `/sell/inventory/v1/offer/${offer.offerId}`);
          repairedQuantity = await rebuildMissingInventoryProduct(typeof currentOffer.categoryId === "string" ? currentOffer.categoryId : undefined);
        } else {
          repairedQuantity = await repairInvalidQuantity();
        }
        await runIdempotentUpdate(() => bulkUpdate(repairedQuantity));
      }
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

  async getListingTraffic(
    _userId: string,
    ebayListingIds: string[],
    start: Date,
    end: Date,
  ): Promise<ListingTrafficMetric[]> {
    if (ebayListingIds.length === 0) return [];
    const metrics = [
      "TOTAL_IMPRESSION_TOTAL",
      "LISTING_VIEWS_TOTAL",
      "CLICK_THROUGH_RATE",
      "SALES_CONVERSION_RATE",
    ];
    const date = (value: Date) => value.toISOString().slice(0, 10).replaceAll("-", "");
    const filter = `listing_ids:{${ebayListingIds.join("|")}},date_range:[${date(start)}..${date(end)}]`;
    const query = new URLSearchParams({
      dimension: "LISTING",
      filter,
      metric: metrics.join(","),
    });
    type TrafficValue = { value?: string; applicable?: boolean };
    type TrafficRecord = { dimensionValues?: TrafficValue[]; metricValues?: TrafficValue[] };
    type TrafficReport = {
      header?: { metrics?: { key?: string }[] };
      records?: TrafficRecord[];
    };
    const report = await this.request<TrafficReport>(
      "GET",
      `/sell/analytics/v1/traffic_report?${query.toString()}`,
    );
    const keys = report.header?.metrics?.map((metric) => metric.key ?? "") ?? metrics;
    const number = (record: TrafficRecord, key: string) => {
      const index = keys.indexOf(key);
      const metric = index >= 0 ? record?.metricValues?.[index] : undefined;
      if (!metric?.applicable || metric.value === undefined) return null;
      const value = Number(metric.value);
      return Number.isFinite(value) ? value : null;
    };
    return (report.records ?? []).flatMap((record) => {
      const ebayListingId = record.dimensionValues?.[0]?.value;
      if (!ebayListingId) return [];
      return [{
        ebayListingId,
        impressions: number(record, "TOTAL_IMPRESSION_TOTAL"),
        views: number(record, "LISTING_VIEWS_TOTAL"),
        clickThroughRate: number(record, "CLICK_THROUGH_RATE"),
        salesConversionRate: number(record, "SALES_CONVERSION_RATE"),
      }];
    });
  }

  async getListingTrafficTrend(
    userId: string,
    ebayListingIds: string[],
    start: Date,
    end: Date,
  ): Promise<ListingTrafficDayMetric[]> {
    if (ebayListingIds.length === 0) return [];
    // eBay only supports listing_ids with the LISTING dimension. Query one
    // day at a time so the product trend stays listing-specific and accurate.
    const dates: Date[] = [];
    const cursor = new Date(start);
    cursor.setUTCHours(0, 0, 0, 0);
    const last = new Date(Math.min(end.getTime(), Date.now() - 86_400_000));
    last.setUTCHours(0, 0, 0, 0);
    while (cursor <= last) {
      dates.push(new Date(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const result: ListingTrafficDayMetric[] = [];
    for (let offset = 0; offset < dates.length; offset += 5) {
      const group = await Promise.all(dates.slice(offset, offset + 5).map(async (date) => {
        const rows = await this.getListingTraffic(userId, ebayListingIds, date, date);
        return {
          date: date.toISOString().slice(0, 10),
          impressions: rows.reduce((sum, row) => sum + (row.impressions ?? 0), 0),
          views: rows.reduce((sum, row) => sum + (row.views ?? 0), 0),
        };
      }));
      result.push(...group);
    }
    return result;
  }

  async getAccountTrafficTrend(
    _userId: string,
    start: Date,
    end: Date,
  ): Promise<ListingTrafficDayMetric[]> {
    const date = (value: Date) => value.toISOString().slice(0, 10).replaceAll("-", "");
    const query = new URLSearchParams({
      dimension: "DAY",
      filter: `marketplace_ids:{${MARKETPLACE}},date_range:[${date(start)}..${date(end)}]`,
      metric: "TOTAL_IMPRESSION_TOTAL,LISTING_VIEWS_TOTAL",
    });
    type Value = { value?: string; applicable?: boolean };
    const report = await this.request<{
      header?: { metrics?: { key?: string }[] };
      records?: { dimensionValues?: Value[]; metricValues?: Value[] }[];
    }>("GET", `/sell/analytics/v1/traffic_report?${query.toString()}`);
    const keys = report.header?.metrics?.map((metric) => metric.key ?? "") ?? [];
    const metric = (values: Value[] | undefined, key: string) => {
      const value = values?.[keys.indexOf(key)];
      const parsed = value?.applicable === false ? 0 : Number(value?.value ?? 0);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return (report.records ?? []).flatMap((record) => {
      const rawDate = record.dimensionValues?.[0]?.value;
      if (!rawDate) return [];
      const parsed = new Date(rawDate);
      const day = /^\d{4}-\d{2}-\d{2}/.test(rawDate)
        ? rawDate.slice(0, 10)
        : Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
      return day ? [{
        date: day,
        impressions: metric(record.metricValues, "TOTAL_IMPRESSION_TOTAL"),
        views: metric(record.metricValues, "LISTING_VIEWS_TOTAL"),
      }] : [];
    });
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

  async getUnfulfilledOrders(): Promise<RemoteFulfillmentOrder[]> {
    type FulfillmentLine = {
      lineItemId?: string;
      legacyItemId?: string;
      sku?: string;
      title?: string;
      quantity?: number;
      lineItemCost?: { value?: string };
      deliveryCost?: { shippingCost?: { value?: string } };
      lineItemFulfillmentStatus?: string;
      lineItemFulfillmentInstructions?: { shipByDate?: string };
      variationAspects?: { name?: string; value?: string }[];
    };
    type FulfillmentOrder = {
      orderId?: string;
      creationDate?: string;
      buyer?: { username?: string };
      fulfillmentStartInstructions?: { shippingStep?: { shipTo?: { fullName?: string; contactAddress?: { addressLine1?: string; postalCode?: string } } } }[];
      orderPaymentStatus?: string;
      orderFulfillmentStatus?: string;
      cancelStatus?: { cancelState?: string };
      lineItems?: FulfillmentLine[];
    };

    const orders: RemoteFulfillmentOrder[] = [];
    const filter = "orderfulfillmentstatus:%7BNOT_STARTED%7CIN_PROGRESS%7D";
    let offset = 0;
    for (;;) {
      const page = await this.request<{ orders?: FulfillmentOrder[]; total?: number }>(
        "GET",
        `/sell/fulfillment/v1/order?filter=${filter}&limit=100&offset=${offset}`,
      );
      for (const order of page.orders ?? []) {
        const fulfillmentStatus = order.orderFulfillmentStatus;
        if (fulfillmentStatus !== "NOT_STARTED" && fulfillmentStatus !== "IN_PROGRESS") continue;
        if (order.cancelStatus?.cancelState && order.cancelStatus.cancelState !== "NONE_REQUESTED") continue;
        if (order.orderPaymentStatus === "FULLY_REFUNDED" || order.orderPaymentStatus === "PENDING") continue;
        if (!order.orderId || !order.creationDate) continue;

        const lines = (order.lineItems ?? []).flatMap((line) => {
          if (!line.lineItemId || !line.legacyItemId) return [];
          if (line.lineItemFulfillmentStatus === "FULFILLED") return [];
          const lineStatus = line.lineItemFulfillmentStatus === "IN_PROGRESS"
            ? "IN_PROGRESS" as const
            : "NOT_STARTED" as const;
          const quantity = Math.max(1, line.quantity ?? 1);
          const totalLineCents = Math.round(parseFloat(line.lineItemCost?.value ?? "0") * 100);
          const shipBy = line.lineItemFulfillmentInstructions?.shipByDate;
          const shipByDate = shipBy ? new Date(shipBy) : null;
          return [{
            lineItemId: line.lineItemId,
            ebayListingId: line.legacyItemId,
            sku: line.sku ?? null,
            title: line.title ?? `eBay listing ${line.legacyItemId}`,
            quantity,
            salePriceCents: Math.round(totalLineCents / quantity),
            shippingChargedCents: Math.round(
              parseFloat(line.deliveryCost?.shippingCost?.value ?? "0") * 100,
            ),
            fulfillmentStatus: lineStatus,
            shipByDate: shipByDate && !Number.isNaN(shipByDate.getTime()) ? shipByDate : null,
            variation: line.variationAspects?.length
              ? line.variationAspects
                  .filter((aspect) => aspect.name && aspect.value)
                  .map((aspect) => `${aspect.name}: ${aspect.value}`)
                  .join(" · ") || null
              : null,
          }];
        });
        if (lines.length === 0) continue;
        orders.push({
          orderId: order.orderId,
          createdAt: new Date(order.creationDate),
          buyerUsername: order.buyer?.username ?? "eBay buyer",
          shippingRecipientName: order.fulfillmentStartInstructions
            ?.map((instruction) => instruction.shippingStep?.shipTo?.fullName?.trim())
            .find(Boolean) ?? null,
          shippingAddressLine1: order.fulfillmentStartInstructions
            ?.map((instruction) => instruction.shippingStep?.shipTo?.contactAddress?.addressLine1?.trim())
            .find(Boolean) ?? null,
          shippingPostalCode: order.fulfillmentStartInstructions
            ?.map((instruction) => instruction.shippingStep?.shipTo?.contactAddress?.postalCode?.trim())
            .find(Boolean) ?? null,
          paymentStatus: order.orderPaymentStatus ?? "PAID",
          fulfillmentStatus,
          lines,
        });
      }
      offset += 100;
      if (!page.orders || page.orders.length < 100) break;
    }
    return orders.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async createShippingFulfillment(_userId: string, input: ShippingFulfillmentInput): Promise<void> {
    await this.request(
      "POST",
      `/sell/fulfillment/v1/order/${encodeURIComponent(input.orderId)}/shipping_fulfillment`,
      {
        lineItems: [{ lineItemId: input.lineItemId, quantity: input.quantity }],
        shippedDate: (input.shippedDate ?? new Date()).toISOString(),
        shippingCarrierCode: input.shippingCarrierCode,
        trackingNumber: input.trackingNumber,
      },
    );
  }

  async getOrders(_userId: string, since: Date): Promise<RemoteOrder[]> {
    type FulfillmentOrder = {
      orderId: string;
      creationDate: string;
      buyer?: { username?: string };
      orderPaymentStatus?: string;
      orderFulfillmentStatus?: string;
      cancelStatus?: { cancelState?: string };
      fulfillmentStartInstructions?: { shippingStep?: { shipTo?: { fullName?: string; contactAddress?: { addressLine1?: string; postalCode?: string } } } }[];
      lineItems?: {
        lineItemId: string;
        legacyItemId?: string;
        quantity: number;
        lineItemCost?: { value?: string };
        deliveryCost?: { shippingCost?: { value?: string } };
      }[];
    };
    type ExistingShippingFulfillment = {
      shipmentTrackingNumber?: string;
      shippingCarrierCode?: string;
      lineItems?: { lineItemId?: string; quantity?: number }[];
    };
    const filter = encodeURIComponent(`creationdate:[${since.toISOString().replace(/\.\d{3}Z$/, ".000Z")}..]`);
    const orders: RemoteOrder[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.request<{ orders?: FulfillmentOrder[]; total?: number }>(
        "GET",
        `/sell/fulfillment/v1/order?filter=${filter}&limit=100&offset=${offset}`,
      );
      // Completed orders no longer appear in getUnfulfilledOrders. Recover
      // their existing eBay fulfillment records so a refresh can populate
      // tracking that was added outside Sellfinity.
      const trackingByLine = new Map<string, { number: string; carrier: string | null }>();
      const completedOrders = (page.orders ?? []).filter(
        (order) => order.orderFulfillmentStatus?.toUpperCase() === "FULFILLED",
      );
      for (let index = 0; index < completedOrders.length; index += 8) {
        const batch = await Promise.all(completedOrders.slice(index, index + 8).map(async (order) => {
          try {
            const response = await this.request<{ fulfillments?: ExistingShippingFulfillment[] }>(
              "GET",
              `/sell/fulfillment/v1/order/${encodeURIComponent(order.orderId)}/shipping_fulfillment`,
            );
            return { order, fulfillments: response.fulfillments ?? [] };
          } catch {
            // Status reconciliation should still succeed if eBay temporarily
            // refuses one order's fulfillment-detail request.
            return { order, fulfillments: [] };
          }
        }));
        for (const { order, fulfillments } of batch) {
          for (const fulfillment of fulfillments) {
            const number = fulfillment.shipmentTrackingNumber?.trim();
            if (!number) continue;
            const referencedLines = fulfillment.lineItems?.flatMap((line) => line.lineItemId ? [line.lineItemId] : []) ?? [];
            const lineIds = referencedLines.length === 0 && order.lineItems?.length === 1
              ? [order.lineItems[0].lineItemId]
              : referencedLines;
            for (const lineItemId of lineIds) {
              trackingByLine.set(lineItemId, {
                number,
                carrier: fulfillment.shippingCarrierCode?.trim() || null,
              });
            }
          }
        }
      }
      for (const order of page.orders ?? []) {
        const lifecycle = ebayImportedOrderState({
          cancelState: order.cancelStatus?.cancelState,
          paymentStatus: order.orderPaymentStatus,
          fulfillmentStatus: order.orderFulfillmentStatus,
        });
        for (const item of order.lineItems ?? []) {
          if (!item.legacyItemId) continue;
          const existingTracking = trackingByLine.get(item.lineItemId);
          const totalCents = Math.round(parseFloat(item.lineItemCost?.value ?? "0") * 100);
          orders.push({
            ebayOrderId: `${order.orderId}-${item.lineItemId}`,
            checkoutOrderId: order.orderId,
            ebayListingId: item.legacyItemId,
            quantity: item.quantity,
            salePriceCents: Math.round(totalCents / Math.max(1, item.quantity)),
            shippingChargedCents: Math.round(
              parseFloat(item.deliveryCost?.shippingCost?.value ?? "0") * 100,
            ),
            buyerUsername: order.buyer?.username ?? "unknown",
            shippingRecipientName: order.fulfillmentStartInstructions
              ?.map((instruction) => instruction.shippingStep?.shipTo?.fullName?.trim())
              .find(Boolean) ?? null,
            shippingAddressLine1: order.fulfillmentStartInstructions
              ?.map((instruction) => instruction.shippingStep?.shipTo?.contactAddress?.addressLine1?.trim())
              .find(Boolean) ?? null,
            shippingPostalCode: order.fulfillmentStartInstructions
              ?.map((instruction) => instruction.shippingStep?.shipTo?.contactAddress?.postalCode?.trim())
              .find(Boolean) ?? null,
            saleDate: new Date(order.creationDate),
            status: lifecycle.status,
            cancelled: lifecycle.cancelled,
            trackingNumber: existingTracking?.number ?? null,
            trackingCarrier: existingTracking?.carrier ?? null,
          });
        }
      }
      offset += 100;
      if (!page.orders || page.orders.length < 100) break;
    }
    return orders;
  }

  async getOrderFinancials(
    _userId: string,
    orderIds: string[],
  ): Promise<RemoteOrderFinancials[]> {
    const results: RemoteOrderFinancials[] = [];
    const unique = [...new Set(orderIds)].slice(0, 50);
    for (let offset = 0; offset < unique.length; offset += 5) {
      const group = await Promise.all(unique.slice(offset, offset + 5).map(async (orderId) => {
        try {
          const response = await this.request<Parameters<typeof parseOrderFinancials>[0]>(
            "GET",
            `/sell/finances/v1/order_earnings/${encodeURIComponent(orderId)}`,
          );
          return parseOrderFinancials(response, orderId);
        } catch (error) {
          if (error instanceof EbayApiError && error.status === 404) return null;
          throw error;
        }
      }));
      results.push(...group.filter((item): item is RemoteOrderFinancials => item !== null));
    }
    return results;
  }
}
