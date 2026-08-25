import { isTransientEbaySystemError } from "./errors";

type RetryOptions = {
  attempts?: number;
  initialDelayMs?: number;
  retryWhen?: (message: string) => boolean;
  wait?: (delayMs: number) => Promise<void>;
};

/** Retry only idempotent eBay operations and only for explicit server-side
 * failures. Validation, policy, authentication, and seller errors surface
 * immediately instead of consuming more API calls. */
export async function runEbayIdempotentUpdate<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 600);
  const wait = options.wait ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const retryable = isTransientEbaySystemError(message) || options.retryWhen?.(message) === true;
      if (attempt === attempts || !retryable) throw error;
      await wait(initialDelayMs * 2 ** (attempt - 1));
    }
  }

  throw new Error("eBay retry loop completed without a result.");
}
