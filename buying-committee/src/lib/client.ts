import { CompanyEnrich } from '@companyenrich/sdk';

/**
 * The subset of the SDK this app calls. Typing against it (instead of the class)
 * lets tests pass a small fake.
 */
export type EnrichClient = Pick<CompanyEnrich, 'companies' | 'people' | 'positions' | 'me'>;

/**
 * Reads COMPANYENRICH_API_KEY from the environment. Fanning out dozens of free
 * counts can hit the rate limit, so allow a few more 429 retries than the default 2;
 * the SDK waits for the `Retry-After` the API sends between attempts. A 30 second
 * timeout per attempt (default 120) stops one stuck request from stalling a run.
 */
export function createClient(apiKey?: string): CompanyEnrich {
  return new CompanyEnrich({ apiKey, maxRetries: 4, timeoutMs: 30_000 });
}
