import {
  ApiError,
  AuthenticationError,
  BadRequestError,
  CompanyEnrichError,
  ConnectionError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  TimeoutError,
  ValidationError,
} from '@companyenrich/sdk';

/**
 * One-line, user-facing description of a CompanyEnrich SDK error.
 * Returns null for anything that is not an SDK error (a real bug), so callers can rethrow it.
 */
export function describeApiError(error: unknown): string | null {
  if (error instanceof AuthenticationError) {
    return 'CompanyEnrich rejected the API key (401). Check COMPANYENRICH_API_KEY; keys live at https://companyenrich.com/dashboard';
  }
  if (error instanceof PaymentRequiredError) {
    return 'CompanyEnrich returned 402: the account is out of credits or the plan does not include this request.';
  }
  if (error instanceof PermissionDeniedError) return 'CompanyEnrich returned 403: this API key may not make this request.';
  if (error instanceof RateLimitError) return 'CompanyEnrich rate limit hit (429) after retries. Try again in a minute.';
  if (error instanceof ValidationError || error instanceof BadRequestError) {
    const fields = error.errors ? Object.values(error.errors).flat().join('; ') : '';
    return `CompanyEnrich rejected the request (${error.status}): ${fields || error.detail || error.title || 'invalid input'}`;
  }
  if (error instanceof ServerError) return `CompanyEnrich had a server error (${error.status}). Trace ID: ${error.traceId ?? 'n/a'}`;
  if (error instanceof ApiError) return `CompanyEnrich returned ${error.status}: ${error.detail ?? error.title ?? 'unexpected error'}`;
  if (error instanceof TimeoutError || error instanceof ConnectionError) return `Could not reach CompanyEnrich: ${error.message}`;
  if (error instanceof CompanyEnrichError && /api key/i.test(error.message)) {
    return 'COMPANYENRICH_API_KEY is not set. Create a key at https://companyenrich.com/dashboard and add it to .env.local';
  }
  if (error instanceof CompanyEnrichError) return error.message;
  return null;
}

/**
 * True when a failed call certainly consumed no credits: the API rejected it (4xx,
 * including 404 not found and 429) or it was never sent (no API key). A 5xx or a
 * dropped connection is ambiguous, so its reservation is kept.
 */
export function certainlyNotBilled(error: unknown): boolean {
  if (error instanceof ApiError) return error.status < 500;
  if (error instanceof TimeoutError || error instanceof ConnectionError) return false;
  return error instanceof CompanyEnrichError;
}

/** An expected failure talking to CompanyEnrich, already described in one line. */
export class UpstreamError extends Error {
  override name = 'UpstreamError';

  constructor(
    message: string,
    /** Credits the failed call may still have used (a 5xx or timeout after sending). */
    readonly uncertainCredits = 0,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Rethrows SDK errors as `UpstreamError` with a readable message; anything else is rethrown as is. */
export function toUpstreamError(error: unknown, uncertainCredits = 0): never {
  const message = describeApiError(error);
  if (message) throw new UpstreamError(message, uncertainCredits, { cause: error });
  throw error;
}
