import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const mocks = vi.hoisted(() => ({ storeImage: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: { generatedListingImage: { create: mocks.storeImage } },
}));

import {
  amazonOriginalImageUrl,
  isEbayPicturePolicyError,
  prepareEbayImages,
} from "@/lib/ebay/image-policy";

describe("eBay image policy preparation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.storeImage.mockReset();
    mocks.storeImage.mockResolvedValue({ id: "repaired-image" });
  });

  it("uses an original Amazon asset URL when a thumbnail URL is undersized", async () => {
    const thumbnail = await sharp({
      create: { width: 120, height: 80, channels: 3, background: "white" },
    }).jpeg().toBuffer();
    const original = await sharp({
      create: { width: 1_200, height: 800, channels: 3, background: "white" },
    }).jpeg().toBuffer();
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => new Response(
      Uint8Array.from(String(url).includes("._AC_SX120_.") ? thumbnail : original),
      { status: 200, headers: { "content-type": "image/jpeg" } },
    )));

    const result = await prepareEbayImages(
      "user-1",
      ["https://m.media-amazon.com/images/I/example._AC_SX120_.jpg"],
    );

    expect(result.imageUrls).toEqual(["https://m.media-amazon.com/images/I/example.jpg"]);
    expect(result.repaired).toBe(0);
    expect(mocks.storeImage).not.toHaveBeenCalled();
  });

  it("creates a 1000-pixel compliant copy when no larger source exists", async () => {
    const small = await sharp({
      create: { width: 300, height: 200, channels: 3, background: "white" },
    }).png().toBuffer();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Uint8Array.from(small), {
      status: 200,
      headers: { "content-type": "image/png" },
    })));

    const result = await prepareEbayImages(
      "user-1",
      ["https://i.ebayimg.com/images/g/example/s-l300.png"],
    );

    expect(result.imageUrls).toEqual(["http://localhost:3000/api/generated-images/repaired-image"]);
    expect(result.repaired).toBe(1);
    const storedBytes = mocks.storeImage.mock.calls[0][0].data.data as Buffer;
    const metadata = await sharp(storedBytes).metadata();
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBe(1_000);
  });

  it("recognizes the eBay error returned by profit-protection revisions", () => {
    expect(isEbayPicturePolicyError(
      "The picture does not follow eBay picture policy requirements. Use a photo that is at least 500 pixels on the longest side.",
    )).toBe(true);
    expect(isEbayPicturePolicyError("The listing is not active on eBay.")).toBe(false);
  });

  it("strips Amazon CDN thumbnail transformations", () => {
    expect(amazonOriginalImageUrl(
      "https://m.media-amazon.com/images/I/example._AC_SL500_.jpg?x=1",
    )).toBe("https://m.media-amazon.com/images/I/example.jpg");
  });
});
