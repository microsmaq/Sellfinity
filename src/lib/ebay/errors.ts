/** Recognize eBay's idempotent "this is already ended" outcomes without
 * swallowing authentication, permission, or network failures. */
export function isAlreadyEndedEbayError(message: string): boolean {
  return /already (?:been )?ended|listing (?:has )?ended|item (?:has )?ended|ended item|not active|listing is closed|auction has already been closed/i.test(
    message,
  );
}

/** Inventory-managed offers cannot be revised while their available quantity
 * is zero/malformed. This is safe to repair to one only for an active listing
 * that Sellfinity is already attempting to update. */
export function isInvalidEbayQuantityError(message: string): boolean {
  return /errorId["']?:?\s*25004|AVAILABLE_QUANTITY|invalid quantity|quantity must be (?:a valid number )?greater than 0/i.test(
    message,
  );
}

export function isTransientEbaySystemError(message: string): boolean {
  return /errorId["']?:?\s*25001|failed \(5\d\d\)|category["']?:["']?System|a system error has occurred/i.test(
    message,
  );
}

export function isMissingEbayInventoryProductError(message: string): boolean {
  return /errorId["']?:?\s*25604|Product not found|Inventory Service can not publish the data/i.test(
    message,
  );
}
