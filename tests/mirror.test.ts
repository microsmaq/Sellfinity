import { describe, expect, it } from "vitest";
import { extractAsin } from "@/lib/mirror/scraper";
import {
  MockAmazonScraper,
  amazonStateForDay,
  productForAsin,
} from "@/lib/mirror/mock-amazon";
import { generateMirrorDescription, generateSeoTitle } from "@/lib/mirror/seo";
import { parseUrlLines } from "@/lib/mirror/pipeline";
import { EBAY_TITLE_MAX } from "@/lib/listings/generate";

describe("extractAsin", () => {
  it("handles the common Amazon URL shapes", () => {
    expect(extractAsin("https://www.amazon.com/dp/B0ABCD1234")).toBe("B0ABCD1234");
    expect(extractAsin("https://amazon.com/gp/product/B0ABCD1234")).toBe("B0ABCD1234");
    expect(
      extractAsin("https://www.amazon.com/Some-Product-Name/dp/B0ABCD1234/ref=sr_1_3?keywords=thing&qid=17"),
    ).toBe("B0ABCD1234");
    expect(extractAsin("https://smile.amazon.co.uk/dp/b0abcd1234?th=1")).toBe(
      "B0ABCD1234",
    );
  });

  it("rejects non-Amazon and non-product URLs", () => {
    expect(extractAsin("https://www.ebay.com/itm/12345")).toBeNull();
    expect(extractAsin("https://notamazon.com/dp/B0ABCD1234")).toBeNull();
    expect(extractAsin("https://fakeamazon.com/dp/B0ABCD1234")).toBeNull();
    expect(extractAsin("https://www.amazon.com/gp/cart")).toBeNull();
    expect(extractAsin("https://www.amazon.com/dp/TOOSHORT")).toBeNull();
    expect(extractAsin("not a url")).toBeNull();
  });
});

describe("productForAsin", () => {
  it("is deterministic per ASIN", () => {
    expect(productForAsin("B0ABCD1234")).toEqual(productForAsin("B0ABCD1234"));
  });

  it("varies across ASINs", () => {
    const a = productForAsin("B0ABCD1234");
    const b = productForAsin("B0ZZZZ9999");
    expect(a.title).not.toBe(b.title);
  });
});

describe("amazonStateForDay", () => {
  it("is deterministic and keeps price within the ±8% band", () => {
    const base = productForAsin("B0ABCD1234").basePriceCents;
    for (let day = 20000; day < 20060; day++) {
      const s = amazonStateForDay("B0ABCD1234", day);
      expect(s).toEqual(amazonStateForDay("B0ABCD1234", day));
      if (s) {
        expect(s.costCents).toBeGreaterThanOrEqual(Math.floor(base * 0.92));
        expect(s.costCents).toBeLessThanOrEqual(Math.ceil(base * 1.08));
      }
    }
  });
});

describe("MockAmazonScraper", () => {
  it("scrapes the same product for any URL shape of the same ASIN", async () => {
    const scraper = new MockAmazonScraper(() => 20000);
    const a = await scraper.scrape("https://www.amazon.com/dp/B0ABCD1234");
    const b = await scraper.scrape(
      "https://www.amazon.com/Fancy-Name/dp/B0ABCD1234/ref=xyz?tag=q",
    );
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
    expect(a!.priceCents).toBeGreaterThan(0);
    expect(a!.imageUrls.length).toBeGreaterThan(0);
  });

  it("returns null for junk", async () => {
    const scraper = new MockAmazonScraper(() => 20000);
    expect(await scraper.scrape("https://example.com")).toBeNull();
  });
});

describe("generateSeoTitle", () => {
  it("appends a condition keyword when it fits and stays within 80 chars", () => {
    const title = generateSeoTitle({ title: "VonHaus Compact Widget, BPA-Free" });
    expect(title).toBe("VonHaus Compact Widget, BPA-Free - Brand New");
    expect(title.length).toBeLessThanOrEqual(EBAY_TITLE_MAX);
  });

  it("never exceeds eBay's cap for long scraped titles", () => {
    const long = "Brand " + "Adjustable Ergonomic Multi-Purpose Kitchen ".repeat(4);
    const title = generateSeoTitle({ title: long });
    expect(title.length).toBeLessThanOrEqual(EBAY_TITLE_MAX);
    expect(title.endsWith(" ")).toBe(false);
  });

  it("collapses whitespace", () => {
    expect(generateSeoTitle({ title: "A   B\t C" })).toContain("A B C");
  });
});

describe("generateMirrorDescription", () => {
  it("includes bullets and policy lines", () => {
    const d = generateMirrorDescription({
      title: "T",
      bulletPoints: ["First bullet", "Second bullet"],
      category: "Toys & Games",
    });
    expect(d).toContain("✔ First bullet");
    expect(d).toContain("✔ Second bullet");
    expect(d).toContain("returns");
  });
});

describe("parseUrlLines", () => {
  it("splits, trims, dedupes, and caps", () => {
    const urls = parseUrlLines("  a \n\nb\r\na\nc  ", 2);
    expect(urls).toEqual(["a", "b"]);
  });
});
