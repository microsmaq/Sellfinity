import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/actions/catalog-review", () => ({ prepareCatalogAutoApproval: vi.fn(), reviewHighConfidenceCatalogNow: vi.fn() }));
import { CatalogAutoApproval } from "@/app/(app)/admin/arbitrage/catalog-auto-approval";
it("shows selected and catalog-wide approval directly with bounded batches and safe scope messaging", () => {
  const html = renderToStaticMarkup(createElement(CatalogAutoApproval, { selectedIds: ["one", "two"], disabled: false, onRunningChange: vi.fn() }));
  expect(html).toContain("Auto-approve high matches"); expect(html).toContain("Auto-approve selected (2)");
  expect(html).toContain("Decisions API"); expect(html).toContain("at least 95%"); expect(html).toContain("no higher than 5%"); expect(html).toContain("Uncertain products stay in review");
  expect(html).toContain("omitted details alone are not conflicts"); expect(html).not.toContain("99%");
  expect(html).toContain("Identity-only review"); expect(html).toContain("do not block admin match approval"); expect(html).not.toContain("last 3 days");
  expect(html).toContain("25 products"); expect(html).toContain("50 products"); expect(html).toContain("100 products"); expect(html).toContain("All eligible products");
});
it("disables selected approval when no rows are selected", () => {
  const html = renderToStaticMarkup(createElement(CatalogAutoApproval, { selectedIds: [], disabled: false, onRunningChange: vi.fn() }));
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Auto-approve selected \(0\)/);
});
