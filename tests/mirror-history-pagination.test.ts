import { describe, expect, it } from "vitest";
import {
  HIDDEN_PUBLISHING_HISTORY_SOURCES,
  publishingHistoryPagination,
} from "@/lib/mirror/history-pagination";

describe("publishing history pagination", () => {
  it("hides price optimization activity", () => {
    expect(HIDDEN_PUBLISHING_HISTORY_SOURCES).toContain("PRICE_OPTIMIZATION");
  });

  it("paginates every visible historical record", () => {
    expect(publishingHistoryPagination(126, 3, 25)).toEqual({
      page: 3,
      pageSize: 25,
      pageCount: 6,
      skip: 50,
    });
  });

  it("clamps invalid and out-of-range pages", () => {
    expect(publishingHistoryPagination(12, 99, 25)).toMatchObject({
      page: 1,
      pageCount: 1,
      skip: 0,
    });
    expect(publishingHistoryPagination(80, -4, 25).page).toBe(1);
  });
});
