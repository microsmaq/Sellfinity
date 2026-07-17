import { db } from "@/lib/db";

const OPENAI_IMAGE_ENDPOINT = "https://api.openai.com/v1/images/edits";
const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;

type ImproveMainImageInput = {
  userId: string;
  sourceImageUrl: string | undefined;
  title: string;
  category: string;
  bulletPoints: string[];
};

export type ImproveMainImageResult =
  | { ok: true; imageUrl: string }
  | { ok: false; error: string };

export function buildHeroImagePrompt(input: {
  title: string;
  category: string;
  bulletPoints: string[];
}): string {
  const verifiedDetails = input.bulletPoints
    .map((point) => point.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join("; ")
    .slice(0, 1_500);

  return `You are an award-winning commercial product photographer specializing in high-converting eCommerce product photography.

Your goal is to create a premium eBay-compliant hero image that looks significantly better than the original supplier image while remaining completely truthful to the product.

PRODUCT CONTEXT
Title: ${input.title.slice(0, 500)}
Category: ${input.category.slice(0, 200)}
Verified supplier details: ${verifiedDetails || "No additional verified details supplied."}

PRIMARY OBJECTIVE
Create an image that immediately stands out through superior photography, composition and merchandising. Do not rely on marketing graphics. The product itself should attract the click.

PRODUCT ACCURACY
The uploaded image is the source of truth. Never modify shape, size, materials, colors, logos, branding, included accessories, quantity, or construction. Everything must accurately represent what the buyer receives.

EBAY COMPLIANT STYLE
Produce a clean marketplace hero image. Avoid promotional graphics. Do not add sale banners, discount graphics, price graphics, coupon graphics, fake review stars, promotional text, "Best Seller", "Limited Time", "Free Shipping", "Money Back Guarantee", "USA Seller", watermarks, company websites, or QR codes. The product should be the hero.

DIFFERENTIATE FROM SUPPLIER PHOTOS
Assume hundreds of sellers use the same supplier image. Create an image that looks professionally photographed instead of copied. Differentiate using a better camera angle, perspective, composition, lighting, arrangement, spacing, depth, and visual hierarchy. Never differentiate by altering the product.

CAMERA ANGLE
Never keep the exact same angle as the supplier photo. Always improve it. Use a premium 3/4 front angle, slight left or right rotation, slight elevated or low angle, or another dynamic but realistic perspective. Maintain accurate proportions with no distortion.

PRODUCT ARRANGEMENT
Professionally merchandise the product. If multiple accessories are included, you may rearrange them, group similar items, fan them outward, create balanced spacing, rotate pieces, open carrying cases, display contents neatly, stack naturally, or partially overlap accessories when appropriate. Keep every included item visible whenever possible.

LIGHTING AND BACKGROUND
Use luxury commercial softbox lighting, high dynamic range, rich contrast, beautiful reflections, deep blacks, pure whites, and professional product photography. Use a pure white #FFFFFF background, soft natural shadow, and optional subtle reflection. No scenery or unrelated props.

PRODUCT SIZE AND QUALITY
The product should occupy approximately 90% of the frame with little empty space. Make it ultra-sharp, magazine-quality, photorealistic, extremely detailed, and suitable for premium retail. Improve clarity, contrast, texture, material realism, and dynamic range without oversaturation.

FINAL QUALITY CHECK
Before finishing, ask: "Would this image receive more clicks than the supplier image purely because it looks professionally photographed?" If not, improve camera angle, perspective, composition, arrangement, and lighting without changing the actual product.

Output one square 1024x1024 opaque hero image.`;
}

function isAllowedSupplierImageUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    const amazonImageHost =
      host === "media-amazon.com" ||
      host.endsWith(".media-amazon.com") ||
      host === "ssl-images-amazon.com" ||
      host.endsWith(".ssl-images-amazon.com") ||
      host === "amazon.com" ||
      host.endsWith(".amazon.com");
    const developmentFixture =
      process.env.NODE_ENV !== "production" && host === "images.unsplash.com";
    return amazonImageHost || developmentFixture;
  } catch {
    return false;
  }
}

async function downloadSourceImage(sourceImageUrl: string): Promise<Blob> {
  if (!isAllowedSupplierImageUrl(sourceImageUrl)) {
    throw new Error("The supplier image host is not approved for AI editing.");
  }
  const response = await fetch(sourceImageUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { "User-Agent": "Sellfinity/1.0 product-image-import" },
  });
  if (!response.ok) {
    throw new Error(`Could not download the Amazon image (${response.status}).`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error("The Amazon image is too large to improve safely.");
  }
  const contentType = response.headers.get("content-type")?.split(";")[0] ?? "";
  if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(contentType)) {
    throw new Error("The Amazon image is not a supported JPEG, PNG, or WebP file.");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error("The Amazon image is empty or too large to improve safely.");
  }
  return new Blob([bytes], { type: contentType });
}

function publicImageUrl(id: string): string {
  const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${appUrl}/api/generated-images/${id}`;
}

export async function improveMainListingImage(
  input: ImproveMainImageInput,
): Promise<ImproveMainImageResult> {
  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  if (!openAiKey) {
    return {
      ok: false,
      error: "OpenAI is required for GPT Image 2 editing.",
    };
  }
  if (!input.sourceImageUrl) {
    return { ok: false, error: "Amazon did not provide a main image." };
  }
  if (!isAllowedSupplierImageUrl(input.sourceImageUrl)) {
    return { ok: false, error: "The supplier image host is not approved for AI editing." };
  }

  try {
    const sourceImage = await downloadSourceImage(input.sourceImageUrl);
    const extension = sourceImage.type === "image/png" ? "png" : sourceImage.type === "image/webp" ? "webp" : "jpg";
    const form = new FormData();
    form.append("model", process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2");
    form.append("image[]", sourceImage, `amazon-main-image.${extension}`);
    form.append("prompt", buildHeroImagePrompt(input));
    form.append("size", "1024x1024");
    form.append("quality", "high");
    form.append("output_format", "jpeg");
    form.append("output_compression", "100");
    form.append("background", "opaque");
    form.append("n", "1");
    const response = await fetch(OPENAI_IMAGE_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${openAiKey}` },
      body: form,
      signal: AbortSignal.timeout(240_000),
    });
    const payload = (await response.json().catch(() => null)) as
      | { data?: Array<{ b64_json?: string; media_type?: string }>; error?: { message?: string } }
      | null;
    if (!response.ok) {
      throw new Error(payload?.error?.message || `OpenAI image editing failed (${response.status}).`);
    }
    const base64 = payload?.data?.[0]?.b64_json;
    if (!base64) throw new Error("OpenAI returned no edited image.");
    const bytes = Buffer.from(base64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) {
      throw new Error("OpenAI returned an empty or oversized image.");
    }

    const mimeType = payload?.data?.[0]?.media_type || "image/jpeg";
    if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(mimeType)) {
      throw new Error("The image provider returned an unsupported image format.");
    }
    const stored = await db.generatedListingImage.create({
      data: { userId: input.userId, mimeType, data: bytes },
      select: { id: true },
    });
    return { ok: true, imageUrl: publicImageUrl(stored.id) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI image improvement failed.";
    return { ok: false, error: message.slice(0, 500) };
  }
}
