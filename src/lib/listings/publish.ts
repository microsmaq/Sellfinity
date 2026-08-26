import "server-only";

import { db } from "@/lib/db";
import { getEbayClientForUser } from "@/lib/ebay";
import { EbayApiError, validateListingInput } from "@/lib/ebay/client";
import { applyShippingStrategyToDescription, applyShippingStrategyToTitle } from "@/lib/ebay/description";
import { prepareEbayImages } from "@/lib/ebay/image-policy";
import { getSharedAmazonProduct } from "@/lib/mirror/shared-catalog";
import { parseImageUrls, serializeImageUrls } from "@/lib/types";
import { listingPricePlan } from "./shipping-strategy";

export type PublishOneResult =
  | {
      ok: true;
      ebayListingId: string;
      priceCents: number;
      buyerShippingCents: number;
      shippingStrategy: string;
      modeledProfitCents: number;
    }
  | { ok: false; error: string };

/** Publish one locally-created draft through the user's connected eBay
 * account. Shared by normal Listings publishing and direct mirror batches. */
export async function publishListingForUser(
  userId: string,
  listingId: string,
  options: {
    recoverSourceUnavailable?: boolean;
    recoverEndedReasons?: Array<"SOURCE_UNAVAILABLE" | "MANUAL">;
  } = {},
): Promise<PublishOneResult> {
  const connection = await db.ebayConnection.findUnique({ where: { userId } });
  if (!connection || connection.status === "DISCONNECTED") {
    return { ok: false, error: "Connect your eBay account in Settings before publishing." };
  }

  const recoveryReasons = options.recoverEndedReasons ??
    (options.recoverSourceUnavailable ? ["SOURCE_UNAVAILABLE" as const] : []);
  const recoveringEnded = recoveryReasons.length > 0;
  const allowedStatus = recoveringEnded ? ["DRAFT", "ENDED"] : ["DRAFT"];
  const draft = await db.listing.findFirst({
    where: {
      id: listingId,
      userId,
      status: { in: allowedStatus },
      ...(recoveringEnded && {
        OR: [
          { status: "DRAFT" },
          { status: "ENDED", endedReason: { in: recoveryReasons } },
        ],
      }),
    },
    include: { product: true },
  });
  if (!draft) return { ok: false, error: "The mirrored draft is no longer available." };

  let imageUrls = parseImageUrls(draft.imageUrlsJson);
  if (imageUrls.length === 0 && draft.product.supplierName === "Amazon") {
    try {
      const source = await getSharedAmazonProduct(draft.product.supplierUrl);
      if (source?.imageUrls.length) {
        imageUrls = source.imageUrls;
        await db.$transaction([
          db.product.update({
            where: { id: draft.product.id },
            data: {
              title: source.title,
              brand: source.brand,
              description: source.description,
              imageUrlsJson: serializeImageUrls(source.imageUrls),
              supplierUrl: source.sourceUrl,
              costCents: source.priceCents,
              shippingCostCents: source.shippingCostCents,
              supplierStock: source.inStock ? 50 : 0,
            },
          }),
          db.listing.update({
            where: { id: draft.id },
            data: { imageUrlsJson: serializeImageUrls(source.imageUrls) },
          }),
        ]);
      }
    } catch (error) {
      return {
        ok: false,
        error: `Could not retrieve the required Amazon image: ${
          error instanceof Error ? error.message : "source lookup failed"
        }`.slice(0, 300),
      };
    }
  }

  const preparedImages = await prepareEbayImages(userId, imageUrls);
  imageUrls = preparedImages.imageUrls;
  if (imageUrls.length === 0) {
    return {
      ok: false,
      error: "No eBay-compliant product image is available. Add an image with at least 500 pixels on its longest side.",
    };
  }

  // Publishing is the final pricing gate for every new draft, including
  // Amazon URL mirroring, Arbitrage batches, and drafts published later from
  // Listings. Recompute from the latest stored Amazon landed cost and the
  // seller's current settings so a stale draft can never bypass target profit,
  // advertising, sitewide discount, or shipping-strategy rules.
  let finalPriceCents = draft.priceCents;
  let finalBuyerShippingCents = draft.buyerShippingCents;
  let finalShippingStrategy = draft.shippingStrategy;
  let modeledProfitCents = 0;
  if (!recoveringEnded) {
    const latestProduct = await db.product.findUnique({ where: { id: draft.product.id } });
    if (!latestProduct) return { ok: false, error: "The Amazon source product no longer exists." };
    const [pricingUser, adminSource, batchItem] = await Promise.all([
      db.user.findUnique({
        where: { id: userId },
        select: {
          ebaySitewideDiscountBps: true,
          ebayAdRateBps: true,
          targetProfitEnabled: true,
          targetProfitMode: true,
          targetProfitMinCents: true,
          targetProfitCents: true,
          pricingStrategy: true,
        },
      }),
      db.adminArbitrageProduct.findUnique({
        where: { asin: latestProduct.supplierProductId.trim().toUpperCase() },
        select: {
          ebayRecommendedPriceCents: true,
          averageCompetitorPriceCents: true,
          ebayPriceCents: true,
        },
      }),
      db.mirrorBatchItem.findFirst({
        where: { listingId: draft.id, sourceReferenceId: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { sourceReferenceId: true },
      }),
    ]);
    if (!pricingUser) return { ok: false, error: "The listing owner no longer exists." };
    const opportunity = batchItem?.sourceReferenceId
      ? await db.arbitrageItem.findUnique({
          where: { ebayItemId: batchItem.sourceReferenceId },
          select: {
            ebayPriceCents: true,
            avgCompPriceCents: true,
            bestSellingPriceCents: true,
          },
        })
      : null;
    const plan = listingPricePlan({
      amazonCostCents: latestProduct.costCents,
      amazonShippingCents: latestProduct.shippingCostCents,
      currentEbayPriceCents: draft.priceCents,
      ebayRecommendedPriceCents:
        opportunity?.bestSellingPriceCents
        ?? adminSource?.ebayRecommendedPriceCents
        ?? opportunity?.ebayPriceCents
        ?? adminSource?.ebayPriceCents
        ?? draft.priceCents,
      averageCompetitorPriceCents:
        opportunity?.avgCompPriceCents
        ?? adminSource?.averageCompetitorPriceCents,
      sitewideDiscountBps: pricingUser.ebaySitewideDiscountBps,
      adRateBps: pricingUser.ebayAdRateBps,
      targetProfitCents: pricingUser.targetProfitEnabled ? pricingUser.targetProfitCents : null,
      targetProfitMode: pricingUser.targetProfitMode,
      targetProfitMinCents: pricingUser.targetProfitMinCents,
      pricingStrategy: pricingUser.pricingStrategy,
    });
    finalPriceCents = plan.itemPriceCents;
    finalBuyerShippingCents = plan.buyerShippingCents;
    finalShippingStrategy = plan.shippingStrategy;
    modeledProfitCents = plan.modeledProfitCents;
    if (
      finalPriceCents !== draft.priceCents
      || finalBuyerShippingCents !== draft.buyerShippingCents
      || finalShippingStrategy !== draft.shippingStrategy
      || latestProduct.suggestedPriceCents !== finalPriceCents
    ) {
      await db.$transaction([
        db.listing.update({
          where: { id: draft.id },
          data: {
            priceCents: finalPriceCents,
            buyerShippingCents: finalBuyerShippingCents,
            shippingStrategy: finalShippingStrategy,
          },
        }),
        db.product.update({
          where: { id: draft.product.id },
          data: { suggestedPriceCents: finalPriceCents },
        }),
      ]);
    }
  }
  const finalTitle = applyShippingStrategyToTitle(draft.title, finalBuyerShippingCents);
  const finalDescription = applyShippingStrategyToDescription(draft.description, finalBuyerShippingCents);
  if (finalTitle !== draft.title || finalDescription !== draft.description) {
    await db.listing.update({
      where: { id: draft.id },
      data: { title: finalTitle, description: finalDescription },
    });
  }

  const input = {
    title: finalTitle,
    description: finalDescription,
    priceCents: finalPriceCents,
    quantity: draft.quantity,
    imageUrls,
    sku: draft.product.sku,
    category: draft.product.category,
    brand: draft.product.brand,
    buyerShippingCents: finalBuyerShippingCents,
  };
  const validationError = validateListingInput(input);
  if (validationError) return { ok: false, error: validationError };

  try {
    const client = await getEbayClientForUser(userId);
    const { ebayListingId } = await client.createListing(input);
    await db.$transaction([
      db.listing.update({
        where: { id: draft.id },
        data: {
          status: "ACTIVE",
          ebayListingId,
          imageUrlsJson: serializeImageUrls(imageUrls),
          publishedAt: new Date(),
          endedAt: null,
          endedReason: null,
        },
      }),
      // Republished Inventory API offers normally receive a new item id. If
      // eBay reuses one, remove its old local tombstone so it can be displayed.
      db.ebayListingSuppression.deleteMany({ where: { userId, ebayListingId } }),
    ]);
    return {
      ok: true,
      ebayListingId,
      priceCents: finalPriceCents,
      buyerShippingCents: finalBuyerShippingCents,
      shippingStrategy: finalShippingStrategy,
      modeledProfitCents,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof EbayApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : "eBay publication failed.",
    };
  }
}

/** A direct-publish failure must not leave a draft behind. Preserve any
 * pre-existing product, but remove the newly-created product when orphaned. */
export async function discardFailedMirrorDraft(
  userId: string,
  listingId: string,
): Promise<void> {
  const listing = await db.listing.findFirst({
    where: { id: listingId, userId, status: "DRAFT" },
    select: { id: true, productId: true },
  });
  if (!listing) return;
  await db.listing.delete({ where: { id: listing.id } });
  const remaining = await db.listing.count({ where: { productId: listing.productId } });
  if (remaining === 0) {
    await db.product.delete({ where: { id: listing.productId } });
  }
}
