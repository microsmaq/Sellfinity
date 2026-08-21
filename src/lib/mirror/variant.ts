import {
  assessProductMatch,
  isApprovedProductMatch,
  type ProductMatchAssessment,
} from "@/lib/arbitrage/product-match";
import {
  rainforestRequest,
  rainforestShippingCents,
  rainforestShippingIsKnown,
} from "./rainforest";
import type { AmazonMatch } from "./match";

export type RainforestVariant = {
  asin?: string;
  title?: string;
  link?: string;
  price?: { value?: number };
  shipping?: { value?: number; raw?: string };
  dimensions?: { name?: string; value?: string }[];
  is_current_product?: boolean;
};

export type VariantProduct = {
  asin?: string;
  title?: string;
  title_excluding_variant_name?: string;
  link?: string;
  main_image?: { link?: string };
  buybox_winner?: {
    price?: { value?: number };
    shipping?: { value?: number; raw?: string };
  };
  variants?: RainforestVariant[];
};

function normalized(value: string): string {
  return ` ${value.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim()} `;
}

function attributeAppears(title: string, value: string): boolean {
  const haystack = normalized(title);
  const needle = normalized(value).trim();
  if (!needle || ["default", "standard", "style"].includes(needle)) return false;
  if (haystack.includes(` ${needle} `)) return true;
  const tokens = needle.split(" ").filter(Boolean);
  const meaningful = tokens.filter((token) => token.length >= 3 || /^\d/.test(token));
  return meaningful.length > 0 && meaningful.every((token) => haystack.includes(` ${token} `));
}

function variantLabel(variant: RainforestVariant): string {
  const dimensions = (variant.dimensions ?? [])
    .map((dimension) =>
      dimension.name && dimension.value ? `${dimension.name}: ${dimension.value}` : null,
    )
    .filter((value): value is string => Boolean(value));
  return [...new Set([variant.title, ...dimensions].filter((value): value is string => Boolean(value)))]
    .join(", ");
}

/** Pick one child ASIN only when the eBay title uniquely identifies every
 * varying Amazon dimension. Ambiguity deliberately returns null. */
export function selectExactAmazonVariant(
  ebayTitle: string,
  variants: RainforestVariant[],
): RainforestVariant | null {
  const usable = variants.filter((variant) => variant.asin);
  if (usable.length <= 1) return usable[0] ?? null;

  const dimensionNames = new Set(
    usable.flatMap((variant) =>
      (variant.dimensions ?? []).map((dimension) => dimension.name).filter(Boolean),
    ) as string[],
  );
  const varyingDimensions = [...dimensionNames].filter((name) => {
    const values = new Set(
      usable.flatMap((variant) =>
        (variant.dimensions ?? [])
          .filter((dimension) => dimension.name === name && dimension.value)
          .map((dimension) => normalized(dimension.value!).trim()),
      ),
    );
    return values.size > 1;
  });

  const scored = usable.flatMap((variant) => {
    let evidence = 0;
    for (const name of varyingDimensions) {
      const candidateValue = variant.dimensions?.find(
        (dimension) => dimension.name === name,
      )?.value;
      const allValues = [
        ...new Set(
          usable.flatMap((item) =>
            (item.dimensions ?? [])
              .filter((dimension) => dimension.name === name && dimension.value)
              .map((dimension) => dimension.value!),
          ),
        ),
      ];
      const mentioned = allValues.filter((value) => attributeAppears(ebayTitle, value));
      if (mentioned.length === 0 || !candidateValue) return [];
      const bestMentionLength = Math.max(...mentioned.map((value) => normalized(value).length));
      if (
        !mentioned.some(
          (value) =>
            normalized(value) === normalized(candidateValue) &&
            normalized(value).length === bestMentionLength,
        )
      ) {
        return [];
      }
      evidence += bestMentionLength;
    }

    // Some Amazon pages omit structured dimensions. In that case require a
    // unique variant-title phrase (for example "8 Pack" or "Matte Black").
    if (varyingDimensions.length === 0) {
      if (!variant.title || !attributeAppears(ebayTitle, variant.title)) return [];
      evidence = normalized(variant.title).length;
    }
    return [{ variant, evidence }];
  });
  if (scored.length === 0) return null;
  scored.sort((left, right) => right.evidence - left.evidence);
  if (scored[1]?.evidence === scored[0].evidence) return null;
  return scored[0].variant;
}

/** Resolve and live-price the exact Amazon child variant represented by an
 * eBay title. Multi-variant products fail closed when the variant is unclear. */
export async function resolveExactAmazonVariant(
  ebay: { title: string; imageUrl?: string | null },
  seed: AmazonMatch,
  options: { workflow?: string; forceFresh?: boolean } = {},
): Promise<(AmazonMatch & { variantAssessment?: ProductMatchAssessment }) | null> {
  if (!process.env.RAINFOREST_API_KEY) return seed;
  const data = await rainforestRequest<{
    request_info?: { success?: boolean };
    product?: VariantProduct;
  }>(
    {
      type: "product",
      asin: seed.asin,
      variant_prices: "true",
    },
    {
      workflow: options.workflow ?? "variant_verification",
      forceFresh: options.forceFresh,
    },
  );
  if (data.request_info?.success === false) {
    throw new Error("Amazon variant lookup returned an incomplete response.");
  }
  const product = data.product;
  if (!product) return null;
  const variants = product.variants ?? [];
  let selected: RainforestVariant;
  // A tracked listing already stores the exact source ASIN that was approved
  // when it was mirrored. Rainforest marks the child represented by the
  // requested ASIN as the current product. Prefer that explicit identity over
  // trying to reconstruct every variation from eBay's shortened title.
  const linkedCurrentVariant = variants.find(
    (variant) =>
      variant.asin === seed.asin && variant.is_current_product === true,
  );
  if (linkedCurrentVariant) {
    selected = linkedCurrentVariant;
  } else if (variants.length > 1) {
    const exact = selectExactAmazonVariant(ebay.title, variants);
    if (!exact) return null;
    selected = exact;
  } else {
    selected = variants[0] ?? {
      asin: product.asin ?? seed.asin,
      title: product.title,
      link: product.link,
      price: product.buybox_winner?.price,
      shipping: product.buybox_winner?.shipping,
      is_current_product: true,
    };
  }

  const asin = selected.asin;
  if (!asin) return null;
  const isCurrentProduct =
    selected.is_current_product === true || asin === product.asin;
  let price = selected.price?.value;
  let shipping = selected.shipping;
  if (typeof price !== "number" && isCurrentProduct) {
    price = product.buybox_winner?.price?.value;
  }
  if (!shipping && isCurrentProduct) {
    shipping = product.buybox_winner?.shipping;
  }
  // Variant summaries usually omit delivery charges. Fetch the selected
  // child only when needed so shipping is exact without spending another
  // credit for the current parent variant.
  if (
    typeof price !== "number" ||
    price <= 0 ||
    !rainforestShippingIsKnown(shipping)
  ) {
    const child = await rainforestRequest<{
      request_info?: { success?: boolean };
      product?: VariantProduct;
    }>(
      {
        type: "product",
        asin,
      },
      {
        workflow: options.workflow ?? "variant_child_price",
        forceFresh: options.forceFresh,
      },
    );
    if (child.request_info?.success === false) {
      throw new Error("Amazon child-variant lookup returned an incomplete response.");
    }
    const childPrice = child.product?.buybox_winner?.price?.value;
    if (typeof childPrice === "number" && childPrice > 0) {
      price = childPrice;
    }
    shipping = child.product?.buybox_winner?.shipping;
  }
  if (typeof price !== "number" || price <= 0) return null;
  if (!rainforestShippingIsKnown(shipping)) return null;

  const baseTitle = product.title_excluding_variant_name ?? seed.title;
  const label = variantLabel(selected);
  const title = label ? `${baseTitle} — ${label}` : product.title ?? seed.title;
  const assessment = await assessProductMatch(
    ebay,
    { title, imageUrl: product.main_image?.link ?? seed.imageUrl },
  );
  if (!isApprovedProductMatch(assessment)) return null;
  return {
    asin,
    title,
    priceCents: Math.round(price * 100),
    shippingCostCents: rainforestShippingCents(shipping),
    url: selected.link ?? `https://www.amazon.com/dp/${asin}`,
    imageUrl: product.main_image?.link ?? seed.imageUrl,
    variantAssessment: assessment,
  };
}
