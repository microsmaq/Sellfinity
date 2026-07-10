// Pure mismatch detection: supplier truth vs. live listing. No I/O.

import type { SupplierProductState } from "@/lib/sourcing/provider";
import { suggestPriceCents } from "@/lib/sourcing/scoring";
import { LISTING_QUANTITY_CAP } from "@/lib/listings/generate";
import { ebayFeeCents, netProfitCents } from "@/lib/fees";
import type { SyncIssueDetails, SyncIssueType } from "@/lib/types";

export type DetectedIssue = {
  type: SyncIssueType;
  details: SyncIssueDetails;
  /** The change that resolves the issue; applied by auto-fix or "Fix now". */
  fix:
    | { kind: "set_quantity"; quantity: number }
    | { kind: "set_price"; priceCents: number }
    | { kind: "end_listing" };
  /**
   * Whether auto-fix plans may apply the fix unprompted. Risk-type issues
   * (oversell, out of stock, loss-making price, supplier gone) are; restock
   * opportunities are flag-only so a deliberately lowered quantity isn't
   * silently raised back.
   */
  autoFixable: boolean;
};

type ListingFacts = { priceCents: number; quantity: number };
type ProductFacts = { shippingCostCents: number };

/**
 * Compare supplier truth against a live listing.
 * `state` is null when the supplier no longer carries the product.
 */
export function detectIssues(
  listing: ListingFacts,
  product: ProductFacts,
  state: SupplierProductState,
): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  if (state === null) {
    return [
      {
        type: "SUPPLIER_GONE",
        details: {
          message:
            "Supplier no longer carries this product. End the listing to avoid unfulfillable orders.",
        },
        fix: { kind: "end_listing" },
        autoFixable: true,
      },
    ];
  }

  if (state.stock === 0) {
    if (listing.quantity > 0) {
      issues.push({
        type: "OUT_OF_STOCK",
        details: {
          message: "Supplier is out of stock but the listing is still selling.",
          field: "quantity",
          expected: 0,
          actual: listing.quantity,
        },
        fix: { kind: "set_quantity", quantity: 0 },
        autoFixable: true,
      });
    }
  } else {
    const expectedQty = Math.min(LISTING_QUANTITY_CAP, state.stock);
    // Oversell risk is always flagged; a below-cap quantity is only a
    // "restock" suggestion when the listing is at zero (i.e. something we or
    // the seller zeroed out) — a deliberately small quantity is not drift.
    if (listing.quantity > expectedQty || listing.quantity === 0) {
      const oversell = listing.quantity > expectedQty;
      issues.push({
        type: "STOCK_DRIFT",
        details: {
          message: oversell
            ? `Listing offers ${listing.quantity} but supplier only has ${state.stock} — oversell risk.`
            : `Supplier restocked (${state.stock} available); listing can go back up to ${expectedQty}.`,
          field: "quantity",
          expected: expectedQty,
          actual: listing.quantity,
        },
        fix: { kind: "set_quantity", quantity: expectedQty },
        autoFixable: oversell,
      });
    }
  }

  if (state.stock > 0) {
    const profitAtCurrentPrice = netProfitCents({
      quantity: 1,
      salePriceCents: listing.priceCents,
      shippingChargedCents: 0,
      ebayFeeCents: ebayFeeCents({
        quantity: 1,
        salePriceCents: listing.priceCents,
        shippingChargedCents: 0,
      }),
      shippingCostCents: product.shippingCostCents,
      cogsCents: state.costCents,
    });
    if (profitAtCurrentPrice <= 0) {
      const expectedPrice = suggestPriceCents({
        marketPriceCents: listing.priceCents,
        costCents: state.costCents,
        shippingCostCents: product.shippingCostCents,
      });
      issues.push({
        type: "COST_RISE",
        details: {
          message: `Supplier cost rose to $${(state.costCents / 100).toFixed(2)} — this listing now sells at a loss.`,
          field: "price",
          expected: expectedPrice,
          actual: listing.priceCents,
        },
        fix: { kind: "set_price", priceCents: expectedPrice },
        autoFixable: true,
      });
    }
  }

  return issues;
}
