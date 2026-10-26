import { afterEach, expect, it, vi } from "vitest";
import sharp from "sharp";
vi.mock("server-only", () => ({}));
afterEach(() => { vi.unstubAllGlobals(); });

async function photo(format: "png" | "webp" = "png") {
  return sharp({ create: { width: 50, height: 40, channels: 3, background: "red" } }).toFormat(format).toBuffer();
}
async function subject() {
  vi.resetModules();
  return import("@/lib/ai/decision-images");
}
it("converts real photos into JPEG data URLs and caches bounded results", async () => {
  const bytes = await photo("webp");
  const fetcher = vi.fn().mockImplementation(async () => new Response(Uint8Array.from(bytes))); vi.stubGlobal("fetch", fetcher);
  const { prepareDecisionImages } = await subject();
  const source = ["https://m.media-amazon.com/images/I/test.webp", "https://i.ebayimg.com/images/test.png"];
  const result = await prepareDecisionImages(source);
  expect(result).toHaveLength(2);
  for (const value of result) {
    expect(value).toMatch(/^data:image\/jpeg;base64,/);
    expect(await sharp(Buffer.from(value.split(",")[1], "base64")).metadata()).toMatchObject({ format: "jpeg", width: 280, height: 280, isProgressive: false });
  }
  expect(await prepareDecisionImages(source)).toEqual(result);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
});
it.each([[1, 1], [1500, 20], [20, 1500], [280, 280], [3500, 2000], [800, 400]])("keeps both output axes in Jev's supported range for a %sx%s source", async (width, height) => {
  const bytes = await sharp({ create: { width, height, channels: 3, background: "red" } }).png().toBuffer();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(Uint8Array.from(bytes))));
  const { prepareDecisionImages } = await subject();
  const [image] = await prepareDecisionImages(["https://i.ebayimg.com/dimensions.png"]);
  const metadata = await sharp(Buffer.from(image.split(",")[1], "base64")).metadata();
  expect(metadata.width).toBeGreaterThanOrEqual(280); expect(metadata.width).toBeLessThanOrEqual(1536);
  expect(metadata.height).toBeGreaterThanOrEqual(280); expect(metadata.height).toBeLessThanOrEqual(1536);
  expect(metadata.isProgressive).toBe(false);
});
it("pads a narrow image without stretching or cutting its contents", async () => {
  const bytes = await sharp({ create: { width: 800, height: 20, channels: 3, background: "red" } }).png().toBuffer();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(Uint8Array.from(bytes))));
  const { prepareDecisionImages } = await subject();
  const [image] = await prepareDecisionImages(["https://i.ebayimg.com/narrow.png"]);
  const decoded = await sharp(Buffer.from(image.split(",")[1], "base64")).raw().toBuffer({ resolveWithObject: true });
  expect(decoded.info).toMatchObject({ width: 800, height: 280 });
  const redRows = Array.from({ length: 280 }, (_, y) => {
    const offset = (y * 800 + 400) * decoded.info.channels;
    return decoded.data[offset] > 200 && decoded.data[offset + 1] < 60;
  }).filter(Boolean).length;
  expect(redRows).toBeGreaterThanOrEqual(18); expect(redRows).toBeLessThanOrEqual(22);
});
it.each(["https://127.0.0.1/photo", "http://m.media-amazon.com/a", "https://m.media-amazon.com.evil.test/a", "https://user:password@i.ebayimg.com/a", "https://i.ebayimg.com:444/a", "file:///a", "https://www.sellfinity.app/admin"])("refuses unsafe image sources: %s", async (url) => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const { prepareDecisionImages } = await subject();
  await expect(prepareDecisionImages([url])).rejects.toThrow("Product photo 1");
  expect(fetcher).not.toHaveBeenCalled();
});
it("checks redirect targets before following them", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } })); vi.stubGlobal("fetch", fetcher);
  const { prepareDecisionImages } = await subject();
  await expect(prepareDecisionImages(["https://i.ebayimg.com/a"])).rejects.toThrow("not approved");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(["html", "oversized", "empty", "404", "stream"])("rejects %s image content rather than sending broken evidence", async (kind) => {
  const response = kind === "oversized" ? new Response("a", { headers: { "content-length": "9000000" } })
    : kind === "stream" ? new Response(new Uint8Array(8 * 1024 * 1024 + 1))
    : kind === "404" ? new Response(null, { status: 404 })
    : new Response(kind === "html" ? "<html>Not an image</html>" : "");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  const { prepareDecisionImages } = await subject();
  await expect(prepareDecisionImages(["https://i.ebayimg.com/a"])).rejects.toThrow("No image evidence was omitted");
});
it("does not cache failed downloads or return a partial pair", async () => {
  const bytes = await photo();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockImplementation(async () => new Response(Uint8Array.from(bytes))); vi.stubGlobal("fetch", fetcher);
  const { prepareDecisionImages } = await subject();
  await expect(prepareDecisionImages(["https://i.ebayimg.com/a"])).rejects.toThrow("404");
  expect(await prepareDecisionImages(["https://i.ebayimg.com/a"])).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
