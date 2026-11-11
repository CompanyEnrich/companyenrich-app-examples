import { CompanyEnrich } from '@companyenrich/sdk';

/** The part of the SDK this app calls. Typing against it lets tests pass a small fake. */
export type BenchmarkClient = Pick<CompanyEnrich, 'companies'>;

/** The server is misconfigured (missing key, bad MAX_CREDITS). The message says how to fix it. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Reads COMPANYENRICH_API_KEY from the server environment; the browser never
 * sees it. The API is sometimes slow, so each attempt times out after 30 seconds
 * instead of the SDK's default 120.
 */
export function createClient(): CompanyEnrich {
  if (!process.env.COMPANYENRICH_API_KEY?.trim()) {
    throw new ConfigError('COMPANYENRICH_API_KEY is not set on the server. Get a key at https://companyenrich.com/dashboard.');
  }
  return new CompanyEnrich({ timeoutMs: 30_000 });
}
