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
  type RemoteOrder,
} from "./client";
import {
  appAccessToken,
  ebayEnvConfig,
  freshAccessToken,
  type EbayEnvConfig,
} from "./oauth";

const MARKETPLACE = "EBAY_US";
const LOCATION_KEY = "sellpilot-primary";
const POLICY_PREFIX = "SellPilot default";

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
      throw new EbayApiError(`eBay ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`);
    }
    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return undefined as T;
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
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
        name: "SellPilot primary location",
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

    await this.request("PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(input.sku)}`, {
      product: {
        title: input.title,
        description: input.description,
        imageUrls: input.imageUrls.slice(0, 12),
        aspects,
      },
      condition: "NEW",
      availability: { shipToLocationAvailability: { quantity: input.quantity } },
    });

    const offer = await this.request<{ offerId: string }>("POST", "/sell/inventory/v1/offer", {
      sku: input.sku,
      marketplaceId: MARKETPLACE,
      format: "FIXED_PRICE",
      availableQuantity: input.quantity,
      categoryId,
      listingDescription: input.description,
      listingPolicies: policies,
      pricingSummary: {
        price: { value: (input.priceCents / 100).toFixed(2), currency: "USD" },
      },
      merchantLocationKey: LOCATION_KEY,
    });

    const published = await this.request<{ listingId: string }>(
      "POST",
      `/sell/inventory/v1/offer/${offer.offerId}/publish`,
    );
    return { ebayListingId: published.listingId };
  }

  /** The offer behind one of our published listings (Inventory API is
   * SKU/offer-keyed; we track eBay's listing id). */
  private async offerIdFor(ebayListingId: string): Promise<{ offerId: string; sku: string }> {
    const listing = await db.listing.findFirst({
      where: { userId: this.userId, ebayListingId },
      include: { product: { select: { sku: true } } },
    });
    if (!listing) throw new EbayApiError(`No local listing for eBay id ${ebayListingId}`);
    const res = await this.request<{ offers?: { offerId: string }[] }>(
      "GET",
      `/sell/inventory/v1/offer?sku=${encodeURIComponent(listing.product.sku)}&marketplace_id=${MARKETPLACE}`,
    );
    const offerId = res.offers?.[0]?.offerId;
    if (!offerId) throw new EbayApiError(`No eBay offer found for SKU ${listing.product.sku}`);
    return { offerId, sku: listing.product.sku };
  }

  async updateListing(ebayListingId: string, update: ListingUpdate): Promise<void> {
    const { offerId, sku } = await this.offerIdFor(ebayListingId);
    await this.request("POST", "/sell/inventory/v1/bulk_update_price_quantity", {
      requests: [
        {
          sku,
          ...(update.quantity !== undefined && {
            shipToLocationAvailability: { quantity: update.quantity },
          }),
          offers: [
            {
              offerId,
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

  async endListing(ebayListingId: string): Promise<void> {
    const { offerId } = await this.offerIdFor(ebayListingId);
    await this.request("POST", `/sell/inventory/v1/offer/${offerId}/withdraw`);
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
