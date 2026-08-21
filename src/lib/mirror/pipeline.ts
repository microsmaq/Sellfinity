// The mirroring pipeline: Amazon URL → imported product + eBay-ready draft
// listing in one step. Publishing reuses the normal listings flow so plan
// limits and the eBay connection requirement apply unchanged.

import { db } from "@/lib/db";
import type { ProductPageScraper } from "./scraper";
import { extractAsin } from "./scraper";
import { sharedCatalogScraper } from "./shared-catalog";

const AMAZON_SUPPLIER_NAME = "Amazon";
import { generateMirrorDescription, generateSourceTitle } from "./seo";
import { LISTING_QUANTITY_CAP } from "@/lib/listings/generate";
import { suggestPriceCents } from "@/lib/sourcing/scoring";
import { serializeImageUrls } from "@/lib/types";
import { grossUpEbayPriceCents } from "@/lib/fees";
import { targetNetProfitPriceCents } from "@/lib/listings/cleanup";
import { improveMainListingImage } from "./improve-main-image";
import { improveListingContent } from "./improve-listing-content";

/** Typical eBay resale premium over the Amazon buy price for dropshipped
 * items; the suggested price undercuts this market estimate. */
const MARKET_MARKUP = 1.35;

/** Nominal supplier stock recorded at mirror time when the page only says
 * "in stock" — the first inventory sync replaces it with live data. */
const NOMINAL_IN_STOCK = 50;

export function sourceMarkupPriceCents(
  sourcePriceCents: number,
  markupPct = 30,
): number {
  return Math.max(99, Math.round(sourcePriceCents * (1 + markupPct / 100)));
}

export type MirrorOutcome = {
  url: string;
  ok: boolean;
  error?: string;
  listingId?: string;
  title?: string;
  priceCents?: number;
  sourcePriceCents?: number;
  imageImprovementStatus?: "SUCCEEDED" | "FALLBACK";
  imageImprovementError?: string;
};

/** Sellers may paste either a full Amazon product URL or a bare ASIN. */
export function normalizeAmazonProductInput(input: string): string {
  const trimmed = input.trim();
  return /^[A-Z0-9]{10}$/i.test(trimmed)
    ? `https://www.amazon.com/dp/${trimmed.toUpperCase()}`
    : trimmed;
}

export async function mirrorUrl(
  userId: string,
  url: string,
  scraper: ProductPageScraper = sharedCatalogScraper,
  opts: {
    /** A known eBay comp price to undercut (e.g. from the arbitrage
     * scanner); without it the market is estimated from the buy price. */
    marketPriceCents?: number;
    /** List at this percentage above the exact scraped Amazon source price.
     * Used by direct-publish batches; takes precedence over market pricing. */
    sourceMarkupPct?: number;
    /** Replace only the eBay listing's lead photo with a truthful AI-edited
     * studio image. Original supplier photos remain available as secondary
     * listing images and on the source Product record. */
    improveMainImage?: boolean;
    /** Rewrite source facts into eBay SEO copy; the standard HTML layout is
     * retained whether this is enabled or disabled. */
    improveListingContent?: boolean;
  } = {},
): Promise<MirrorOutcome> {
  const sourceUrl = normalizeAmazonProductInput(url);
  const inputAsin = extractAsin(sourceUrl);
  if (inputAsin) {
    const alreadyImported = await db.product.findUnique({
      where: { userId_sku: { userId, sku: inputAsin } },
      select: { id: true },
    });
    if (alreadyImported) {
      return { url, ok: false, error: `Already imported (SKU ${inputAsin}).` };
    }
  }
  const scraped = await scraper.scrape(sourceUrl);
  if (!scraped) {
    return {
      url,
      ok: false,
      error: "Not a recognizable Amazon product URL, or the product page is unavailable.",
    };
  }
  if (scraped.imageUrls.length === 0) {
    return {
      url,
      ok: false,
      error: "Amazon did not return a usable product image. Refresh the source and try again.",
    };
  }

  const existing = await db.product.findUnique({
    where: { userId_sku: { userId, sku: scraped.sourceId } },
  });
  if (existing) {
    return { url, ok: false, error: `Already imported (SKU ${scraped.sourceId}).` };
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { ebaySitewideDiscountBps: true, ebayAdRateBps: true, targetProfitEnabled: true, targetProfitCents: true },
  });
  const sitewideDiscountBps = user?.ebaySitewideDiscountBps ?? 0;
  const adRateBps = user?.ebayAdRateBps ?? 300;
  const targetProfitCents = user?.targetProfitEnabled ? user.targetProfitCents : null;
  const priceCents =
    targetProfitCents !== null
      ? targetNetProfitPriceCents(
          scraped.priceCents,
          scraped.shippingCostCents,
          targetProfitCents,
          sitewideDiscountBps,
          adRateBps,
        )
      : opts.sourceMarkupPct !== undefined
      ? grossUpEbayPriceCents(sourceMarkupPriceCents(
          scraped.priceCents + scraped.shippingCostCents,
          opts.sourceMarkupPct,
        ), sitewideDiscountBps)
      : suggestPriceCents({
          marketPriceCents:
            opts.marketPriceCents ??
            Math.round(
              (scraped.priceCents + scraped.shippingCostCents) * MARKET_MARKUP,
            ),
          costCents: scraped.priceCents,
          shippingCostCents: scraped.shippingCostCents,
        }, sitewideDiscountBps, adRateBps, targetProfitCents);
  const supplierStock = scraped.inStock ? NOMINAL_IN_STOCK : 0;

  const contentImprovement = opts.improveListingContent
    ? await improveListingContent(scraped)
    : null;
  const listingCopy = contentImprovement?.ok
    ? { ...scraped, ...contentImprovement.content }
    : scraped;
  const title = contentImprovement?.ok
    ? contentImprovement.content.title
    : generateSourceTitle(scraped);
  const description = generateMirrorDescription(listingCopy);
  const imageImprovement = opts.improveMainImage
    ? await improveMainListingImage({
        userId,
        sourceImageUrl: scraped.imageUrls[0],
        title: scraped.title,
        category: scraped.category,
        bulletPoints: scraped.bulletPoints,
      })
    : null;
  const listingImages = imageImprovement?.ok
    ? [imageImprovement.imageUrl, ...scraped.imageUrls].slice(0, 12)
    : scraped.imageUrls;

  const listing = await db.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        userId,
        sku: scraped.sourceId,
        title: scraped.title,
        brand: scraped.brand,
        description: scraped.description,
        imageUrlsJson: serializeImageUrls(scraped.imageUrls),
        category: scraped.category,
        supplierName: AMAZON_SUPPLIER_NAME,
        supplierProductId: scraped.sourceId,
        supplierUrl: scraped.sourceUrl,
        costCents: scraped.priceCents,
        supplierStock,
        shippingCostCents: scraped.shippingCostCents,
        suggestedPriceCents: priceCents,
        sourceScore: 0, // not from the sourcing feed; no score
      },
    });
    return tx.listing.create({
      data: {
        userId,
        productId: product.id,
        title,
        description,
        priceCents,
        quantity: Math.min(LISTING_QUANTITY_CAP, supplierStock),
        imageUrlsJson: serializeImageUrls(listingImages),
        status: "DRAFT",
      },
    });
  });

  return {
    url,
    ok: true,
    listingId: listing.id,
    title,
    priceCents,
    sourcePriceCents: scraped.priceCents,
    ...(imageImprovement && {
      imageImprovementStatus: imageImprovement.ok ? "SUCCEEDED" : "FALLBACK",
      imageImprovementError: imageImprovement.ok ? undefined : imageImprovement.error,
    }),
  };
}

/** Split pasted bulk input into candidate URLs (one per line, blanks dropped). */
export function parseUrlLines(input: string, max: number): string[] {
  return [...new Set(
    input
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  )].slice(0, max);
}
