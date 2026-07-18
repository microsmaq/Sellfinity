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
    .slice(0, 1_200);

  return `You are an award-winning commercial product photographer and ecommerce merchandising director.

Create a COMPLETELY NEW premium studio photograph of the referenced product. Treat the uploaded supplier image only as the factual product reference. Do not retouch, polish, relight, or lightly reframe the supplier photograph itself. This must look like a separate professional photoshoot, not an edited supplier image.

PRODUCT CONTEXT
Title: ${input.title.slice(0, 500)}
Category: ${input.category.slice(0, 200)}
Verified supplier details: ${verifiedDetails || "No additional verified details supplied."}

MANDATORY VISIBLE TRANSFORMATION
The result must be immediately and unmistakably different when viewed beside the supplier image. A background cleanup, color correction, mild crop, subtle shadow, or small exposure change is a failed result.

Build a genuinely new composition with ALL of these clearly visible changes:
1. Use a noticeably different but realistic camera viewpoint, preferably a premium 3/4 view with a 10-20 degree elevation or an equally strong category-appropriate angle.
2. Recompose and rescale the product so it occupies 88-92% of the square frame with intentional premium spacing.
3. Replace the original lighting with dimensional luxury softbox lighting, stronger subject separation, controlled highlights, rich natural contrast, and a realistic ground shadow.
4. Create new visual depth and hierarchy. For multi-piece products, visibly re-merchandise the included pieces into a balanced retail arrangement.

Do not return a near-copy of the input composition. Change the viewpoint, silhouette placement within the frame, lighting direction, shadow geometry, and overall merchandising—not merely one of them.

PRODUCT TRUTH
The uploaded image is the source of truth for what the buyer receives. Preserve the exact product identity, proportions, construction, materials, colors, surface patterns, branding, logos, quantity, included accessories, controls, ports, fasteners, and functional parts. Do not invent, remove, duplicate, recolor, relabel, redesign, or substitute anything. Existing brand names and visible labels must remain correctly spelled and recognizable; never invent marketing text. A new viewpoint is explicitly required, but it must not distort the product or expose guessed internal or hidden details.

EBAY COMPLIANT STYLE
Produce a clean marketplace hero image. Avoid promotional graphics. Do not add sale banners, discount graphics, price graphics, coupon graphics, fake review stars, promotional text, "Best Seller", "Limited Time", "Free Shipping", "Money Back Guarantee", "USA Seller", watermarks, company websites, or QR codes. The product should be the hero.

PRODUCT ARRANGEMENT
Professionally merchandise the product instead of copying the supplier layout. If multiple separate accessories are clearly included, rearrange them, group similar pieces, fan them outward, rotate them, create balanced spacing, display case contents neatly, stack naturally, or partially overlap pieces where appropriate. Keep the correct quantity and every important included item visible.

LIGHTING AND BACKGROUND
Use luxury commercial softbox lighting, high dynamic range, rich contrast, beautiful reflections, deep blacks, pure whites, and professional product photography. Use a pure white #FFFFFF background, soft natural shadow, and optional subtle reflection. No scenery or unrelated props.

IMAGE QUALITY
Make the result ultra-sharp, photorealistic, magazine-quality commercial photography suitable for a top-tier retail product page. Render believable texture, material response, reflections, edge detail, and dynamic range without oversaturation or artificial sharpening.

FINAL ACCEPTANCE TEST
Before finishing, compare the proposed result mentally with the reference. It passes only if (a) a buyer would receive the exact referenced product and (b) a shopper would instantly recognize this as a substantially different, professionally reshot hero image. If it still resembles the supplier composition, rebuild the camera viewpoint, composition, merchandising, lighting, depth, and shadow before returning it.

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
      // Keep a buffer inside the five-minute route limit for database storage
      // and the subsequent eBay listing update.
      signal: AbortSignal.timeout(210_000),
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
