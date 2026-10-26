import "server-only";
import sharp from "sharp";

const MAX_DOWNLOAD = 8 * 1024 * 1024;
const MAX_ENCODED_IMAGE = 2 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const images = new Map<string, { data: string; expires: number }>();
let cacheBytes = 0;

export class DecisionImageError extends Error {}

function approved(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
    return ["media-amazon.com", "ssl-images-amazon.com", "ebayimg.com"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)) ||
      (["www.sellfinity.app", "sellfinity.app"].includes(url.hostname) && url.pathname.startsWith("/api/generated-images/"));
  } catch { return false; }
}

async function download(raw: string): Promise<Buffer> {
  let current = raw;
  const signal = AbortSignal.timeout(10_000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!approved(current)) throw new DecisionImageError("Product image host is not approved for server-side verification.");
    const response = await fetch(current, { redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 3) throw new DecisionImageError("Product image redirected too many times.");
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new DecisionImageError(`Product image download failed (HTTP ${response.status}).`); }
    if (Number(response.headers.get("content-length") || 0) > MAX_DOWNLOAD) { await response.body?.cancel(); throw new DecisionImageError("Product image exceeds the 8 MB download limit."); }
    if (!response.body) throw new DecisionImageError("Product image download was empty.");
    const reader = response.body.getReader();
    const parts: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_DOWNLOAD) { await reader.cancel(); throw new DecisionImageError("Product image exceeds the 8 MB download limit."); }
        parts.push(Buffer.from(part.value));
      }
    } finally { reader.releaseLock(); }
    if (!size) throw new DecisionImageError("Product image download was empty.");
    return Buffer.concat(parts);
  }
  throw new DecisionImageError("Product image could not be downloaded.");
}

async function prepare(raw: string): Promise<string> {
  const saved = images.get(raw);
  if (saved && saved.expires > Date.now()) return saved.data;
  if (saved) { cacheBytes -= saved.data.length; images.delete(raw); }
  const bytes = await download(raw);
  const decoder = sharp(bytes, { limitInputPixels: 25_000_000, animated: false });
  const metadata = await decoder.metadata();
  if (!metadata.width || !metadata.height || !["jpeg", "png", "webp"].includes(metadata.format || "")) throw new DecisionImageError("Product image is not a readable JPEG, PNG or WebP photo.");
  // Jev requires BOTH axes >= 280. Preserve every source pixel/aspect ratio;
  // pad small or panoramic photos rather than stretching or cropping evidence.
  const resized = await decoder.rotate().resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true }).flatten({ background: "#fff" }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const extraWidth = Math.max(0, 280 - resized.info.width);
  const extraHeight = Math.max(0, 280 - resized.info.height);
  const normalized = await sharp(resized.data, { raw: { width: resized.info.width, height: resized.info.height, channels: resized.info.channels } })
    .extend({ left: Math.floor(extraWidth / 2), right: Math.ceil(extraWidth / 2), top: Math.floor(extraHeight / 2), bottom: Math.ceil(extraHeight / 2), background: "#fff" })
    .jpeg({ quality: 90, progressive: false }).toBuffer();
  if (normalized.length > MAX_ENCODED_IMAGE) throw new DecisionImageError("Product image is too large to send for verification.");
  const data = `data:image/jpeg;base64,${normalized.toString("base64")}`;
  while (images.size && (images.size >= 64 || cacheBytes + data.length > MAX_CACHE_BYTES)) {
    const oldest = images.keys().next().value!;
    cacheBytes -= images.get(oldest)!.data.length;
    images.delete(oldest);
  }
  images.set(raw, { data, expires: Date.now() + 10 * 60_000 });
  cacheBytes += data.length;
  return data;
}

/** Only trusted marketplace photos; never persist image bytes in catalog records. */
export async function prepareDecisionImages(urls: string[]): Promise<string[]> {
  if (urls.length > 2) throw new DecisionImageError("At most two product photos can be verified together.");
  return Promise.all(urls.map(async (url, index) => {
    try { return await prepare(url); }
    catch (error) {
      const detail = error instanceof DecisionImageError ? error.message : "The image could not be downloaded or decoded.";
      throw new DecisionImageError(`Product photo ${index + 1}: ${detail} No image evidence was omitted.`);
    }
  }));
}
