/** Recognize eBay's idempotent "this is already ended" outcomes without
 * swallowing authentication, permission, or network failures. */
export function isAlreadyEndedEbayError(message: string): boolean {
  return /already (?:been )?ended|listing (?:has )?ended|item (?:has )?ended|not active|listing is closed/i.test(
    message,
  );
}
