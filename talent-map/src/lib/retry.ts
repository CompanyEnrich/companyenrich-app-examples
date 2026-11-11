import { RateLimitError } from '@companyenrich/sdk';

/**
 * Retries a call only when the API answered 429, which is never billed. Paid GET requests are made
 * with `{ maxRetries: 0 }` so the SDK does not repeat them after a 5xx or a dropped connection,
 * where the first attempt may already have been charged; this puts back the safe half of that.
 */
export async function retryOnRateLimit<T>(call: () => Promise<T>, attempts = 3, baseDelayMs = 1000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof RateLimitError) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}
