import { CompanyEnrich } from '@companyenrich/sdk';
import type { Limiter } from './concurrency';

/** The SDK reads COMPANYENRICH_API_KEY from the environment. The API is sometimes slow, so allow 30 s. */
export function createClient(): CompanyEnrich {
  return new CompanyEnrich({ timeoutMs: 30_000 });
}

/** Most CompanyEnrich requests in flight at once, per process. */
export const API_CONCURRENCY = 4;

/** Runs one SDK request behind the shared concurrency limit. */
export type ApiCall = <T>(request: (client: CompanyEnrich) => Promise<T>) => Promise<T>;

/**
 * The client is created on the first request, so free-mail and cached leads work
 * without an API key, and a missing key surfaces as a rejected call, not a crash.
 */
export function apiCaller(getClient: () => CompanyEnrich, limiter: Limiter): ApiCall {
  let client: CompanyEnrich | undefined;
  return (request) =>
    limiter.run(async () => {
      client ??= getClient();
      return request(client);
    });
}
