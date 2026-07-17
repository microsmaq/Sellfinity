import { db } from "@/lib/db";

const OPENAI_IMAGE_ENDPOINT = "https://api.openai.com/v1/images/edits";
const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_QA_MODEL = "gpt-5.6-sol";

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

function responseText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ text?: unknown }> }>;
  };
  if (typeof data.output_text === "string") return data.output_text;
  const parts = data.output
    ?.flatMap((item) => item.content ?? [])
    .map((part) => part.text)
    .filter((part): part is string => typeof part === "string");
  return parts?.length ? parts.join("") : null;
}

function blobDataUrl(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then(
    (buffer) => `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`,
  );
}

async function inspectImageSafety(
  apiKey: string,
  sourceImage: string,
  generatedImage?: string,
): Promise<{ approved: boolean; materiallyDifferent?: boolean; reason: string } | null> {
  const isComparison = !!generatedImage;
  const prompt = isComparison
    ? `Act as a strict ecommerce image authenticity and creative-quality inspector. Compare the original supplier image with the proposed edited image. Set approved=true only when BOTH conditions pass: (1) the exact product identity, shape, proportions, construction, material, color, pattern, quantity, accessories, controls, ports, logos, brand names, model numbers, printed text, labels, and packaging are unchanged; and (2) the new hero image is immediately and materially different from the supplier photo through at least two substantive improvements such as composition, product scale/crop, safe perspective, accessory spacing, studio lighting, depth, or ground shadow. Set materiallyDifferent=false and reject a near-copy, simple background cleanup, tiny crop, mild exposure adjustment, or other change a shopper would barely notice. Always reject unreadable, misspelled, replaced, invented, blurred, or distorted text/branding, any changed component, or any uncertain product detail.`
    : `Act as a strict ecommerce image-editing risk inspector. Determine whether a generative edit can safely preserve this product. Reject editing if the product or packaging shows any visible brand name, logo, model number, printed words, labels, measurement markings, display text, safety text, or other identity-critical fine detail. Also reject if the exact quantity, pattern, transparent/reflective construction, or small components could be easily altered. When uncertain, reject. An original supplier image is better than a polished but inaccurate image.`;
  const schema = {
    type: "object",
    additionalProperties: false,
    required: isComparison
      ? ["approved", "materiallyDifferent", "reason"]
      : ["approved", "reason"],
    properties: {
      approved: { type: "boolean" },
      ...(isComparison && { materiallyDifferent: { type: "boolean" } }),
      reason: { type: "string" },
    },
  };
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_IMAGE_QA_MODEL?.trim() || IMAGE_QA_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", image_url: sourceImage, detail: "high" },
              ...(generatedImage
                ? [{ type: "input_image", image_url: generatedImage, detail: "high" }]
                : []),
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: isComparison ? "image_identity_check" : "image_edit_risk_check",
            strict: true,
            schema,
          },
        },
        max_output_tokens: 250,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return null;
    const text = responseText(await response.json());
    if (!text) return null;
    const parsed = JSON.parse(text) as {
      approved?: unknown;
      materiallyDifferent?: unknown;
      reason?: unknown;
    };
    return typeof parsed.approved === "boolean" &&
      typeof parsed.reason === "string" &&
      (!isComparison || typeof parsed.materiallyDifferent === "boolean")
      ? {
          approved: parsed.approved,
          ...(isComparison && { materiallyDifferent: parsed.materiallyDifferent as boolean }),
          reason: parsed.reason.slice(0, 300),
        }
      : null;
  } catch {
    return null;
  }
}

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
- Every existing logo, brand name, model number, word, label, display, symbol, and measurement marking must remain pixel-faithful, correctly spelled, readable, and in the exact original position. Never redraw text from imagination.
- Do not hide flaws or alter the apparent condition.
- If a new perspective cannot be rendered with complete geometric accuracy from the reference, keep a close, truthful perspective instead of guessing unseen details.
- Rearrange separate accessories only when every component and its quantity are completely unambiguous; otherwise preserve their arrangement.

PREMIUM CREATIVE DIRECTION
- The result MUST be immediately and materially different from the supplier photo while preserving the exact product. A simple white-background cleanup, tiny crop, or mild exposure change is not an enhancement.
- Make at least three clearly visible creative improvements chosen from: stronger premium composition, meaningfully tighter product scale/crop, safe viewpoint adjustment, improved accessory spacing, richer studio lighting, stronger depth separation, and a refined realistic ground shadow.
- Present the product as luxury commercial studio photography, clearly differentiated through composition, lighting, crop, depth, spacing, and visual hierarchy rather than changing the item.
- Use the most flattering truthful perspective: a noticeable premium three-quarter view or 10-20 degree elevation only when the supplied pixels support it. Never invent unseen geometry or distort perspective.
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
  if (!openAiKey) {
    return {
      ok: false,
      error: "OpenAI is required for quality-controlled GPT Image 2 editing.",
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
    const sourceDataUrl = await blobDataUrl(sourceImage);
    const preflight = await inspectImageSafety(openAiKey, sourceDataUrl);
    if (!preflight) {
      return {
        ok: false,
        error: "Original retained because the image safety inspection was unavailable.",
      };
    }
    if (!preflight.approved) {
      return {
        ok: false,
        error: `Original retained to protect product text and identity: ${preflight.reason}`,
      };
    }
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
    const generatedDataUrl = `data:${mimeType};base64,${base64}`;
    const identityCheck = await inspectImageSafety(
      openAiKey,
      sourceDataUrl,
      generatedDataUrl,
    );
    if (!identityCheck) {
      return {
        ok: false,
        error: "Original retained because the generated-image identity check was unavailable.",
      };
    }
    if (!identityCheck.approved || !identityCheck.materiallyDifferent) {
      return {
        ok: false,
        error: `Generated image rejected; original retained: ${
          identityCheck.materiallyDifferent === false
            ? `the edit was not visually different enough. ${identityCheck.reason}`
            : identityCheck.reason
        }`,
      };
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
