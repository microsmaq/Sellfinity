import {
  assessProductMatch,
  isApprovedProductMatch,
  type ProductMatchAssessment,
} from "@/lib/arbitrage/product-match";
import { rainforestRequest } from "./rainforest";
import type { AmazonMatch } from "./match";

export type RainforestVariant = {
  asin?: string;
  title?: string;
  link?: string;
  price?: { value?: number };
  dimensions?: { name?: string; value?: string }[];
  is_current_product?: boolean;
};

export type VariantProduct = {
  asin?: string;
  title?: string;
  title_excluding_variant_name?: string;
  link?: string;
  main_image?: { link?: string };
  buybox_winner?: { price?: { value?: number } };
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
): Promise<(AmazonMatch & { variantAssessment?: ProductMatchAssessment }) | null> {
  if (!process.env.RAINFOREST_API_KEY) return seed;
  const data = await rainforestRequest<{ product?: VariantProduct }>({
    type: "product",
    asin: seed.asin,
    variant_prices: "true",
  });
  const product = data.product;
  if (!product) return null;
  const variants = product.variants ?? [];
  let selected: RainforestVariant;
  if (variants.length > 1) {
    const exact = selectExactAmazonVariant(ebay.title, variants);
    if (!exact) return null;
    selected = exact;
  } else {
    selected = variants[0] ?? {
      asin: product.asin ?? seed.asin,
      title: product.title,
      link: product.link,
      price: product.buybox_winner?.price,
      is_current_product: true,
    };
  }

  const asin = selected.asin;
  if (!asin) return null;
  let price = selected.price?.value;
  if (typeof price !== "number" && selected.is_current_product) {
    price = product.buybox_winner?.price?.value;
  }
  if (typeof price !== "number" || price <= 0) {
    const child = await rainforestRequest<{ product?: VariantProduct }>({
      type: "product",
      asin,
    });
    price = child.product?.buybox_winner?.price?.value;
  }
  if (typeof price !== "number" || price <= 0) return null;

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
    url: selected.link ?? `https://www.amazon.com/dp/${asin}`,
    imageUrl: product.main_image?.link ?? seed.imageUrl,
    variantAssessment: assessment,
  };
}
