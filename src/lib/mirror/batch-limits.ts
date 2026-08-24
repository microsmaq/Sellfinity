export function uniqueBatchIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

export function uniqueInputLines(input: string, max?: number): string[] {
  const lines = [...new Set(
    input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  )];
  return max === undefined ? lines : lines.slice(0, max);
}
