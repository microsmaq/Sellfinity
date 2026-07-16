// The mirroring pipeline: Amazon URL → imported product + eBay-ready draft
// listing in one step. Publishing reuses the normal listings flow so plan
// limits and the eBay connection requirement apply unchanged.

import { db } from "@/lib/db";
import { getScraper } from "./index";
import type { ProductPageScraper } from "./scraper";
import { extractAsin } from "./scraper";

const AMAZON_SUPPLIER_NAME = "Amazon";
import { generateMirrorDescription, generateSeoTitle } from "./seo";
import { LISTING_QUANTITY_CAP } from "@/lib/listings/generate";
import { suggestPriceCents } from "@/lib/sourcing/scoring";
import { serializeImageUrls } from "@/lib/types";
import { improveMainListingImage } from "./improve-main-image";

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

export async function mirrorUrl(
  userId: string,
  url: string,
  scraper: ProductPageScraper = getScraper(),
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
  } = {},
): Promise<MirrorOutcome> {
  const inputAsin = extractAsin(url);
  if (inputAsin) {
    const alreadyImported = await db.product.findUnique({
      where: { userId_sku: { userId, sku: inputAsin } },
      select: { id: true },
    });
    if (alreadyImported) {
      return { url, ok: false, error: `Already imported (SKU ${inputAsin}).` };
    }
  }
  const scraped = await scraper.scrape(url);
  if (!scraped) {
    return {
      url,
      ok: false,
      error: "Not a recognizable Amazon product URL, or the product page is unavailable.",
    };
  }

  const existing = await db.product.findUnique({
    where: { userId_sku: { userId, sku: scraped.sourceId } },
  });
  if (existing) {
    return { url, ok: false, error: `Already imported (SKU ${scraped.sourceId}).` };
  }

  const priceCents =
    opts.sourceMarkupPct !== undefined
      ? sourceMarkupPriceCents(scraped.priceCents, opts.sourceMarkupPct)
      : suggestPriceCents({
          marketPriceCents:
            opts.marketPriceCents ?? Math.round(scraped.priceCents * MARKET_MARKUP),
          costCents: scraped.priceCents,
          shippingCostCents: 0, // fulfilled via Amazon free shipping
        });
  const supplierStock = scraped.inStock ? NOMINAL_IN_STOCK : 0;

  const title = generateSeoTitle(scraped);
  const description = generateMirrorDescription(scraped);
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
        description: scraped.description,
        imageUrlsJson: serializeImageUrls(scraped.imageUrls),
        category: scraped.category,
        supplierName: AMAZON_SUPPLIER_NAME,
        supplierProductId: scraped.sourceId,
        supplierUrl: scraped.sourceUrl,
        costCents: scraped.priceCents,
        supplierStock,
        shippingCostCents: 0,
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
