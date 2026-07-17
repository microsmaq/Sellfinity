import ExcelJS from "exceljs";

export type ExcelFileResult = { filename: string; base64: string };

function styleSheet(sheet: ExcelJS.Worksheet, widths: number[]) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: widths.length } };
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF312E81" } };
  header.alignment = { vertical: "middle" };
  header.height = 24;
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1 && rowNumber % 2 === 1) {
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
    }
    row.alignment = { vertical: "top" };
  });
}

function setLink(cell: ExcelJS.Cell, label: string, hyperlink: string | null) {
  if (!hyperlink) {
    cell.value = "";
    return;
  }
  cell.value = { text: label, hyperlink };
  cell.font = { color: { argb: "FF2563EB" }, underline: true };
}

export type ListingsExcelRow = {
  title: string;
  ebayListingId: string;
  listingDate: string | null;
  ebayUrl: string;
  ebayPriceCents: number;
  amazonUrl: string | null;
  amazonPriceCents: number | null;
  profitCents: number | null;
  marginPct: number | null;
  estimatedSales30d: number | null;
  competitorCount: number | null;
  ebayRecommendedPriceCents: number | null;
  averageCompetitorPriceCents: number | null;
  suggestedPriceCents: number | null;
  matchVerdict: string | null;
  matchConfidence: number | null;
  matchReason: string | null;
  status: string;
};

export async function createListingsWorkbook(
  rows: ListingsExcelRow[],
): Promise<ExcelFileResult> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Sellfinity";
  const sheet = workbook.addWorksheet("Listings");
  sheet.addRow([
    "Product", "eBay item ID", "Listing date", "eBay price", "Amazon cost", "Profit / unit",
    "Margin", "Est. sales / 30d", "Competition", "eBay market recommendation",
    "Avg. comp price", "AI suggested price", "Match", "Match confidence", "Match reason",
    "Status", "eBay link", "Amazon link",
  ]);
  for (const item of rows) {
    const row = sheet.addRow([
      item.title,
      item.ebayListingId,
      item.listingDate ? new Date(item.listingDate) : null,
      item.ebayPriceCents / 100,
      item.amazonPriceCents === null ? null : item.amazonPriceCents / 100,
      item.profitCents === null ? null : item.profitCents / 100,
      item.marginPct === null ? null : item.marginPct / 100,
      item.estimatedSales30d,
      item.competitorCount,
      item.ebayRecommendedPriceCents === null
        ? null
        : item.ebayRecommendedPriceCents / 100,
      item.averageCompetitorPriceCents === null
        ? null
        : item.averageCompetitorPriceCents / 100,
      item.suggestedPriceCents === null ? null : item.suggestedPriceCents / 100,
      item.matchVerdict,
      item.matchConfidence === null ? null : item.matchConfidence / 100,
      item.matchReason,
      item.status,
      "",
      "",
    ]);
    setLink(row.getCell(17), "Open on eBay", item.ebayUrl);
    setLink(row.getCell(18), "Open on Amazon", item.amazonUrl);
  }
  sheet.getColumn(3).numFmt = "mmm d, yyyy";
  [4, 5, 6, 10, 11, 12].forEach((column) => (sheet.getColumn(column).numFmt = '"$"#,##0.00'));
  sheet.getColumn(7).numFmt = "0%";
  sheet.getColumn(14).numFmt = "0%";
  sheet.getColumn(2).numFmt = "@";
  styleSheet(sheet, [46, 18, 16, 14, 14, 14, 11, 16, 13, 22, 16, 18, 14, 18, 48, 15, 18, 18]);
  const buffer = await workbook.xlsx.writeBuffer();
  return {
    filename: `sellfinity-listings-${new Date().toISOString().slice(0, 10)}.xlsx`,
    base64: Buffer.from(buffer).toString("base64"),
  };
}

export type ArbitrageExcelRow = {
  title: string;
  category: string;
  ebayPriceCents: number;
  amazonPriceCents: number;
  profitCents: number | null;
  marginPct: number | null;
  estimatedSales30d: number;
  competitorCount: number | null;
  averageCompetitorPriceCents: number | null;
  suggestedPriceCents: number | null;
  matchVerdict: string;
  matchConfidence: number;
  matchReason: string | null;
  ebayUrl: string;
  amazonUrl: string;
};

export async function createArbitrageWorkbook(
  rows: ArbitrageExcelRow[],
): Promise<ExcelFileResult> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Sellfinity";
  const sheet = workbook.addWorksheet("Arbitrage Finder");
  sheet.addRow([
    "Product", "Category", "Match", "Match confidence", "Match reason",
    "eBay price", "Amazon candidate cost", "Profit / unit", "Margin",
    "Est. sales / 30d", "Competition", "Avg. comp price",
    "Suggested price", "eBay link", "Amazon link",
  ]);
  for (const item of rows) {
    const row = sheet.addRow([
      item.title,
      item.category,
      item.matchVerdict,
      item.matchConfidence / 100,
      item.matchReason,
      item.ebayPriceCents / 100,
      item.amazonPriceCents / 100,
      item.profitCents === null ? null : item.profitCents / 100,
      item.marginPct === null ? null : item.marginPct / 100,
      item.estimatedSales30d,
      item.competitorCount,
      item.averageCompetitorPriceCents === null
        ? null
        : item.averageCompetitorPriceCents / 100,
      item.suggestedPriceCents === null ? null : item.suggestedPriceCents / 100,
      "",
      "",
    ]);
    setLink(row.getCell(14), "Open on eBay", item.ebayUrl);
    setLink(row.getCell(15), "Open on Amazon", item.amazonUrl);
  }
  [6, 7, 8, 12, 13].forEach((column) => (sheet.getColumn(column).numFmt = '"$"#,##0.00'));
  sheet.getColumn(4).numFmt = "0%";
  sheet.getColumn(9).numFmt = "0%";
  styleSheet(sheet, [46, 20, 13, 18, 48, 14, 18, 14, 11, 16, 13, 16, 16, 18, 18]);
  const buffer = await workbook.xlsx.writeBuffer();
  return {
    filename: `sellfinity-arbitrage-${new Date().toISOString().slice(0, 10)}.xlsx`,
    base64: Buffer.from(buffer).toString("base64"),
  };
}
