import { db } from "@/lib/db";

const OPENAI_IMAGE_ENDPOINT = "https://api.openai.com/v1/images/edits";
const OPENROUTER_IMAGE_ENDPOINT = "https://openrouter.ai/api/v1/images";
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

  return `You are an award-winning ecommerce creative director, senior commercial product photographer, and conversion-rate optimization specialist.

Create one premium, high-converting eBay hero image by EDITING the supplied product photograph. The uploaded image is the only visual source of truth. The result must remain a truthful photograph of the exact product a buyer receives.

PRODUCT CONTEXT
Title: ${input.title.slice(0, 500)}
Category: ${input.category.slice(0, 200)}
Verified supplier details: ${verifiedDetails || "No additional verified details supplied."}

NON-NEGOTIABLE PRODUCT ACCURACY
- Preserve the exact product identity, shape, proportions, dimensions, construction, materials, colors, surface patterns, branding, logos, quantity, accessories, controls, ports, fasteners, and functional parts.
- Do not invent, remove, replace, duplicate, enlarge, shrink, recolor, relabel, or redesign any product or included component.
- Do not hide flaws or alter the apparent condition.
- If a new perspective cannot be rendered with complete geometric accuracy from the reference, keep a close, truthful perspective instead of guessing unseen details.
- Rearrange separate accessories only when every component and its quantity are completely unambiguous; otherwise preserve their arrangement.

PREMIUM CREATIVE DIRECTION
- Present the product as luxury commercial studio photography, clearly differentiated through lighting, crop, depth, spacing, and visual hierarchy rather than changing the item.
- Use the most flattering truthful perspective: a subtle premium three-quarter view or slight 10-20 degree elevation when safe. Never distort perspective.
- Make the product and all included components occupy approximately 88-92% of a square frame without clipping anything.
- Use a pure white #FFFFFF background, clean edge separation, a soft realistic ground shadow, crisp detail, rich but natural blacks, clean whites, controlled highlights, and premium softbox lighting.
- Improve clarity, contrast, texture rendering, and perceived production quality without oversaturation or artificial sharpening halos.

EBAY IMAGE COMPLIANCE
- Absolutely no text, captions, badges, feature icons, marketing claims, prices, shipping claims, guarantees, seller claims, calls to action, borders, frames, watermarks, added logos, or decorative artwork.
- Do not add props, packaging, people, hands, scenery, environmental backgrounds, or objects not present in the supplier image.
- Output one square 1024x1024 opaque JPEG-style hero image with no transparency.

FINAL SELF-CHECK
Before returning the image, verify that a buyer comparing it with the supplier reference would receive exactly the same product, quantity, variant, color, and accessories. If any edit creates uncertainty, favor product truth over creative differentiation.`;
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
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!openAiKey && !openRouterKey) {
    return { ok: false, error: "No OpenAI or OpenRouter image API key is configured." };
  }
  if (!input.sourceImageUrl) {
    return { ok: false, error: "Amazon did not provide a main image." };
  }
  if (!isAllowedSupplierImageUrl(input.sourceImageUrl)) {
    return { ok: false, error: "The supplier image host is not approved for AI editing." };
  }

  try {
    let response: Response;
    if (openAiKey) {
      const sourceImage = await downloadSourceImage(input.sourceImageUrl);
      const extension = sourceImage.type === "image/png" ? "png" : sourceImage.type === "image/webp" ? "webp" : "jpg";
      const form = new FormData();
      form.append("model", process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2");
      form.append("image[]", sourceImage, `amazon-main-image.${extension}`);
      form.append("prompt", buildHeroImagePrompt(input));
      form.append("size", "1024x1024");
      form.append("quality", "medium");
      form.append("output_format", "jpeg");
      form.append("background", "opaque");
      form.append("n", "1");
      response = await fetch(OPENAI_IMAGE_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${openAiKey}` },
        body: form,
        signal: AbortSignal.timeout(180_000),
      });
    } else {
      response = await fetch(OPENROUTER_IMAGE_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openRouterKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL ?? "https://www.sellfinity.app",
          "X-Title": "Sellfinity",
        },
        body: JSON.stringify({
          model: process.env.OPENROUTER_IMAGE_MODEL?.trim() || "openai/gpt-image-1",
          prompt: buildHeroImagePrompt(input),
          input_references: [
            { type: "image_url", image_url: { url: input.sourceImageUrl } },
          ],
          size: "1024x1024",
          quality: "medium",
          output_format: "jpeg",
          output_compression: 85,
          background: "opaque",
          n: 1,
        }),
        signal: AbortSignal.timeout(180_000),
      });
    }
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
