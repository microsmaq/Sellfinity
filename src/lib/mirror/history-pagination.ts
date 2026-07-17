export const HIDDEN_PUBLISHING_HISTORY_SOURCES = ["PRICE_OPTIMIZATION"] as const;

export function publishingHistoryPagination(
  total: number,
  requestedPage: number,
  requestedPageSize: number,
): { page: number; pageSize: number; pageCount: number; skip: number } {
  const pageSize = Math.min(100, Math.max(10, requestedPageSize));
  const pageCount = Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
  const page = Math.min(pageCount, Math.max(1, requestedPage));
  return { page, pageSize, pageCount, skip: (page - 1) * pageSize };
}
