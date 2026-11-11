import { RateLimitError, type RequestOptions } from '@companyenrich/sdk';

const ATTEMPTS = 3;

/**
 * Runs a paid GET (people.get, companies.enrich, companies.get) with the SDK's own retries off, so
 * under a credit cap one reserved lookup always matches one request. Only a rate limit, which is
 * never billed, is retried here.
 */
export async function paidGet<T>(call: (options: RequestOptions) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call({ maxRetries: 0 });
    } catch (error) {
      if (!(error instanceof RateLimitError) || attempt >= ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(error, attempt)));
    }
  }
}

function retryDelayMs(error: RateLimitError, attempt: number): number {
  const retryAfter = error.headers.get('retry-after');
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000 * 2 ** attempt;
}
