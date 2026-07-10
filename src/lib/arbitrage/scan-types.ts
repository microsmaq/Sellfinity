/** Outcome of one scan advance (shared by real and sandbox scanners). */
export type ScanReport = {
  /** New opportunities added to the research database. */
  added: number;
  /** Candidates examined this run (≈ paid lookups on the real scanner). */
  examined: number;
  /** True when today's keyword pool is fully scanned. */
  exhausted: boolean;
};
