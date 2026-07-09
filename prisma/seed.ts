// Seeds a demo account with a realistic month of selling activity:
//   email: demo@sellfinity.dev  password: demo1234
// Orders and sync history are produced by the same pipeline the app uses
// (sandbox eBay client + mock supplier), not hand-inserted rows.

import bcrypt from "bcryptjs";
import { db } from "../src/lib/db";
import { getSupplierProvider } from "../src/lib/sourcing";
import { scoreCandidate, suggestPriceCents } from "../src/lib/sourcing/scoring";
import { generateListing } from "../src/lib/listings/generate";
import { mirrorUrl } from "../src/lib/mirror/pipeline";
import { importOrders } from "../src/lib/orders/import";
import { runSync } from "../src/lib/sync/engine";
import { serializeImageUrls } from "../src/lib/types";

const DAY_MS = 86_400_000;

async function main() {
  const email = "demo@sellfinity.dev";
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    console.log("Demo user already exists — deleting and reseeding.");
    await db.user.delete({ where: { id: existing.id } });
  }

  const user = await db.user.create({
    data: {
      email,
      name: "Demo Seller",
      passwordHash: await bcrypt.hash("demo1234", 10),
    },
  });

  await db.ebayConnection.create({
    data: {
      userId: user.id,
      status: "SANDBOX",
      ebayUsername: "demo_seller_2026",
      accessToken: "sandbox-placeholder-token",
      connectedAt: new Date(Date.now() - 40 * DAY_MS),
    },
  });

  // Import a spread of products from the sourcing feed.
  const provider = getSupplierProvider();
  const candidates = await provider.getTrendingCandidates();
  const picked = candidates.filter((_, i) => i % 3 === 0).slice(0, 12);

  let listedCount = 0;
  for (const candidate of picked) {
    const scored = scoreCandidate(candidate);
    const product = await db.product.create({
      data: {
        userId: user.id,
        sku: candidate.supplierProductId,
        title: candidate.title,
        description: candidate.description,
        imageUrlsJson: serializeImageUrls(candidate.imageUrls),
        category: candidate.category,
        supplierName: candidate.supplierName,
        supplierProductId: candidate.supplierProductId,
        supplierUrl: candidate.supplierUrl,
        costCents: candidate.costCents,
        supplierStock: candidate.stock,
        shippingCostCents: candidate.shippingCostCents,
        suggestedPriceCents: suggestPriceCents(candidate),
        sourceScore: scored.score,
        createdAt: new Date(Date.now() - 35 * DAY_MS),
      },
    });

    const content = generateListing({
      title: product.title,
      description: product.description,
      category: product.category,
      imageUrls: candidate.imageUrls,
      suggestedPriceCents: product.suggestedPriceCents,
      supplierStock: Math.max(product.supplierStock, 3),
    });

    // First 9 published over the past month, one ended, last two left as drafts.
    listedCount++;
    const status = listedCount <= 9 ? "ACTIVE" : listedCount === 10 ? "ENDED" : "DRAFT";
    const publishedAt =
      status === "DRAFT"
        ? null
        : new Date(Date.now() - (34 - listedCount * 2) * DAY_MS);

    await db.listing.create({
      data: {
        userId: user.id,
        productId: product.id,
        title: content.title,
        description: content.description,
        priceCents: content.priceCents,
        quantity: status === "ENDED" ? 0 : content.quantity,
        imageUrlsJson: serializeImageUrls(content.imageUrls),
        status,
        ebayListingId:
          status === "DRAFT" ? null : `1105${String(550000 + listedCount * 137)}`,
        publishedAt,
        endedAt: status === "ENDED" ? new Date(Date.now() - 3 * DAY_MS) : null,
      },
    });
  }

  // Mirror a few Amazon products through the real pipeline; publish two.
  const asins = ["B0CKWXY123", "B0DMLPQ456", "B0FZRTV789"];
  let mirrored = 0;
  for (const [i, asin] of asins.entries()) {
    const outcome = await mirrorUrl(user.id, `https://www.amazon.com/dp/${asin}`);
    if (!outcome.ok || !outcome.listingId) continue;
    mirrored++;
    if (i < 2) {
      await db.listing.update({
        where: { id: outcome.listingId },
        data: {
          status: "ACTIVE",
          ebayListingId: `1106${String(770000 + i * 331)}`,
          publishedAt: new Date(Date.now() - (12 - i * 5) * DAY_MS),
        },
      });
    }
  }

  // Pull a month of sandbox orders through the real import pipeline.
  const { imported } = await importOrders(user.id);

  // One sync run so the inventory page has history (PRO plan → auto-fixes).
  const summary = await runSync(user.id);

  console.log(
    `Seeded demo account: ${picked.length} sourced + ${mirrored} mirrored products, ` +
      `${imported} orders, sync found ${summary.issuesFound} issue(s) ` +
      `(${summary.issuesAutoFixed} auto-fixed).`,
  );
  console.log("Login: demo@sellfinity.dev / demo1234");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
