export const AUTO_RESTOCK_THRESHOLD = 2;
export const AUTO_RESTOCK_TARGET = 5;

/** Only confirmed live quantities of zero or one qualify. */
export function shouldAutoRestock(quantity: number | null): boolean {
  return quantity !== null && quantity >= 0 && quantity < AUTO_RESTOCK_THRESHOLD;
}
