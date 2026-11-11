import { ConnectionError, RateLimitError, ServerError, TimeoutError } from '@companyenrich/sdk';

/**
 * Per-request options for paid GETs (`companies.workforce`, `people.findEmail`).
 * Sent once (`maxRetries: 0`), so under a credit cap one reservation always matches one
 * request. 429s are retried by `retryOnRateLimit`.
 */
export const PAID_GET_OPTIONS = { maxRetries: 0, timeoutMs: 30_000 } as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry only rate-limited calls: a 429 was not processed, so it was not billed. */
export async function retryOnRateLimit<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof RateLimitError) || attempt >= attempts) throw error;
      const retryAfter = Number(error.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * attempt);
    }
  }
}

/**
 * After a failed paid call: could the API still have processed (and billed) it?
 * A timeout or dropped connection is ambiguous, so the ledger assumes the worst.
 */
export function mayHaveBeenCharged(error: unknown): boolean {
  return error instanceof TimeoutError || error instanceof ConnectionError || error instanceof ServerError;
}
