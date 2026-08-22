import "server-only";

import sharp from "sharp";

import { db } from "@/lib/db";

export const EBAY_MIN_IMAGE_LONG_SIDE = 500;
const EBAY_REPAIRED_IMAGE_LONG_SIDE = 1_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export type PreparedEbayImages = {
  imageUrls: string[];
  repaired: number;
  rejected: number;
};

function publicImageUrl(id: string): string {
  const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${appUrl}/api/generated-images/${id}`;
}

function isApprovedImageUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return process.env.NODE_ENV !== "production" && url.hostname === "localhost";
    const host = url.hostname.toLowerCase();
    const appHost = (() => {
      try {
        return process.env.APP_URL ? new URL(process.env.APP_URL).hostname.toLowerCase() : null;
      } catch {
        return null;
      }
    })();
    return (
      host === appHost ||
      host === "media-amazon.com" ||
      host.endsWith(".media-amazon.com") ||
      host === "ssl-images-amazon.com" ||
      host.endsWith(".ssl-images-amazon.com") ||
      host === "amazon.com" ||
      host.endsWith(".amazon.com") ||
      host === "ebayimg.com" ||
      host.endsWith(".ebayimg.com") ||
      (process.env.NODE_ENV !== "production" && host === "images.unsplash.com")
    );
  } catch {
    return false;
  }
}

/** Amazon thumbnail URLs often encode a resize instruction between `._` and
 * `_.`; removing it asks the image CDN for the original asset. */
export function amazonOriginalImageUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (!(host === "media-amazon.com" || host.endsWith(".media-amazon.com") || host === "ssl-images-amazon.com" || host.endsWith(".ssl-images-amazon.com"))) return null;
    const originalPath = url.pathname.replace(/\._[^/]*_\.(jpe?g|png|webp)$/i, ".$1");
    if (originalPath === url.pathname) return null;
    url.pathname = originalPath;
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function downloadApprovedImage(rawUrl: string): Promise<Buffer> {
  let currentUrl = rawUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    if (!isApprovedImageUrl(currentUrl)) throw new Error("Unapproved image host");
    const response = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      headers: { "User-Agent": "Sellfinity/1.0 eBay-image-policy" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS) throw new Error("Image redirected too many times");
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (!response.ok) throw new Error(`Image download failed (${response.status})`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_IMAGE_BYTES) throw new Error("Image is too large");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Image is empty or too large");
    return bytes;
  }
  throw new Error("Image download failed");
}

async function imageLongSide(bytes: Buffer): Promise<number> {
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Image dimensions are unavailable");
  if (!new Set(["jpeg", "png", "webp"]).has(metadata.format ?? "")) throw new Error("Unsupported image format");
  return Math.max(metadata.width, metadata.height);
}

async function storeUpscaledImage(userId: string, bytes: Buffer): Promise<string> {
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Image dimensions are unavailable");
  const resized = await sharp(bytes)
    .resize({
      width: metadata.width >= metadata.height ? EBAY_REPAIRED_IMAGE_LONG_SIDE : undefined,
      height: metadata.height > metadata.width ? EBAY_REPAIRED_IMAGE_LONG_SIDE : undefined,
      fit: "inside",
      withoutEnlargement: false,
    })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
  const stored = await db.generatedListingImage.create({
    data: { userId, mimeType: "image/jpeg", data: Uint8Array.from(resized) },
    select: { id: true },
  });
  return publicImageUrl(stored.id);
}

/** Keep compliant originals, recover full-size Amazon assets where possible,
 * and upscale only as a final fallback. Unreadable/non-image URLs are omitted. */
export async function prepareEbayImages(userId: string, rawUrls: string[]): Promise<PreparedEbayImages> {
  const results = await Promise.all([...new Set(rawUrls)].slice(0, 12).map(async (rawUrl) => {
    try {
      let selectedUrl = rawUrl;
      let bytes = await downloadApprovedImage(selectedUrl);
      let longSide = await imageLongSide(bytes);

      if (longSide < EBAY_MIN_IMAGE_LONG_SIDE) {
        const originalUrl = amazonOriginalImageUrl(rawUrl);
        if (originalUrl) {
          try {
            const originalBytes = await downloadApprovedImage(originalUrl);
            const originalLongSide = await imageLongSide(originalBytes);
            if (originalLongSide > longSide) {
              selectedUrl = originalUrl;
              bytes = originalBytes;
              longSide = originalLongSide;
            }
          } catch {
            // Fall through to a local standards-compliant copy.
          }
        }
      }

      if (longSide < EBAY_MIN_IMAGE_LONG_SIDE) {
        selectedUrl = await storeUpscaledImage(userId, bytes);
        return { imageUrl: selectedUrl, repaired: true };
      }
      return { imageUrl: selectedUrl, repaired: false };
    } catch {
      return null;
    }
  }));

  return {
    imageUrls: results.flatMap((result) => result ? [result.imageUrl] : []),
    repaired: results.filter((result) => result?.repaired).length,
    rejected: results.filter((result) => !result).length,
  };
}

export function isEbayPicturePolicyError(message: string): boolean {
  return /(?:picture|photo|image).{0,120}(?:500\s*pixel|policy requirements?|longest side)|500\s*pixel.{0,120}(?:picture|photo|image)/i.test(message);
}
