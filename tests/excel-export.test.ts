import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  createArbitrageWorkbook,
  createListingsWorkbook,
} from "@/lib/export/excel";

async function load(base64: string) {
  const workbook = new ExcelJS.Workbook();
  const bytes = Buffer.from(base64, "base64") as unknown as Parameters<
    typeof workbook.xlsx.load
  >[0];
  await workbook.xlsx.load(bytes);
  return workbook;
}

describe("Excel exports", () => {
  it("exports typed listing values and marketplace hyperlinks", async () => {
    const file = await createListingsWorkbook([
      {
        title: "Milk Frother",
        ebayListingId: "123456789",
        ebayUrl: "https://www.ebay.com/itm/123456789",
        ebayPriceCents: 2499,
        amazonUrl: "https://www.amazon.com/dp/B0TEST",
        amazonPriceCents: 999,
        profitCents: 687,
        marginPct: 27,
        estimatedSales30d: 20,
        competitorCount: 45,
        averageCompetitorPriceCents: 2599,
        suggestedPriceCents: 2499,
        status: "OK",
      },
    ]);
    const workbook = await load(file.base64);
    const sheet = workbook.getWorksheet("Listings")!;
    expect(sheet.getCell("C2").value).toBe(24.99);
    expect(sheet.getCell("F2").value).toBe(0.27);
    expect(sheet.getCell("L2").value).toEqual({
      text: "Open on eBay",
      hyperlink: "https://www.ebay.com/itm/123456789",
    });
    expect(sheet.autoFilter).toBeTruthy();
  });

  it("exports all arbitrage metrics and Amazon links", async () => {
    const file = await createArbitrageWorkbook([
      {
        title: "Milk Frother",
        category: "Home & Kitchen",
        ebayPriceCents: 2499,
        amazonPriceCents: 999,
        profitCents: 687,
        marginPct: 27,
        estimatedSales30d: 20,
        competitorCount: 45,
        averageCompetitorPriceCents: 2599,
        suggestedPriceCents: 2499,
        ebayUrl: "https://www.ebay.com/itm/123",
        amazonUrl: "https://www.amazon.com/dp/B0TEST",
      },
    ]);
    const workbook = await load(file.base64);
    const sheet = workbook.getWorksheet("Arbitrage Finder")!;
    expect(sheet.getCell("J2").value).toBe(24.99);
    expect(sheet.getCell("L2").value).toEqual({
      text: "Open on Amazon",
      hyperlink: "https://www.amazon.com/dp/B0TEST",
    });
  });
});
