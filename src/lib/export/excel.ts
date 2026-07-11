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
  ebayUrl: string;
  ebayPriceCents: number;
  amazonUrl: string | null;
  amazonPriceCents: number | null;
  profitCents: number | null;
  marginPct: number | null;
  estimatedSales30d: number | null;
  competitorCount: number | null;
  averageCompetitorPriceCents: number | null;
  suggestedPriceCents: number | null;
  status: string;
};

export async function createListingsWorkbook(
  rows: ListingsExcelRow[],
): Promise<ExcelFileResult> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Sellfinity";
  const sheet = workbook.addWorksheet("Listings");
  sheet.addRow([
    "Product", "eBay item ID", "eBay price", "Amazon cost", "Profit / unit",
    "Margin", "Est. sales / 30d", "Competition", "Avg. comp price",
    "Suggested price", "Status", "eBay link", "Amazon link",
  ]);
  for (const item of rows) {
    const row = sheet.addRow([
      item.title,
      item.ebayListingId,
      item.ebayPriceCents / 100,
      item.amazonPriceCents === null ? null : item.amazonPriceCents / 100,
      item.profitCents === null ? null : item.profitCents / 100,
      item.marginPct === null ? null : item.marginPct / 100,
      item.estimatedSales30d,
      item.competitorCount,
      item.averageCompetitorPriceCents === null
        ? null
        : item.averageCompetitorPriceCents / 100,
      item.suggestedPriceCents === null ? null : item.suggestedPriceCents / 100,
      item.status,
      "",
      "",
    ]);
    setLink(row.getCell(12), "Open on eBay", item.ebayUrl);
    setLink(row.getCell(13), "Open on Amazon", item.amazonUrl);
  }
  [3, 4, 5, 9, 10].forEach((column) => (sheet.getColumn(column).numFmt = '"$"#,##0.00'));
  sheet.getColumn(6).numFmt = "0%";
  sheet.getColumn(2).numFmt = "@";
  styleSheet(sheet, [46, 18, 14, 14, 14, 11, 16, 13, 16, 16, 15, 18, 18]);
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
  profitCents: number;
  marginPct: number;
  estimatedSales30d: number;
  competitorCount: number | null;
  averageCompetitorPriceCents: number | null;
  suggestedPriceCents: number;
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
    "Product", "Category", "eBay price", "Amazon cost", "Profit / unit",
    "Margin", "Est. sales / 30d", "Competition", "Avg. comp price",
    "Suggested price", "eBay link", "Amazon link",
  ]);
  for (const item of rows) {
    const row = sheet.addRow([
      item.title,
      item.category,
      item.ebayPriceCents / 100,
      item.amazonPriceCents / 100,
      item.profitCents / 100,
      item.marginPct / 100,
      item.estimatedSales30d,
      item.competitorCount,
      item.averageCompetitorPriceCents === null
        ? null
        : item.averageCompetitorPriceCents / 100,
      item.suggestedPriceCents / 100,
      "",
      "",
    ]);
    setLink(row.getCell(11), "Open on eBay", item.ebayUrl);
    setLink(row.getCell(12), "Open on Amazon", item.amazonUrl);
  }
  [3, 4, 5, 9, 10].forEach((column) => (sheet.getColumn(column).numFmt = '"$"#,##0.00'));
  sheet.getColumn(6).numFmt = "0%";
  styleSheet(sheet, [46, 20, 14, 14, 14, 11, 16, 13, 16, 16, 18, 18]);
  const buffer = await workbook.xlsx.writeBuffer();
  return {
    filename: `sellfinity-arbitrage-${new Date().toISOString().slice(0, 10)}.xlsx`,
    base64: Buffer.from(buffer).toString("base64"),
  };
}
