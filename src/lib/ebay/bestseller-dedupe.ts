export function countGloballyNewBestSellers(
  items: { itemId: string }[],
  storedItemIds: Iterable<string>,
): number {
  const known = new Set(storedItemIds);
  let added = 0;
  for (const item of items) {
    if (!item.itemId || known.has(item.itemId)) continue;
    known.add(item.itemId);
    added += 1;
  }
  return added;
}
