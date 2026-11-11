import {
  ApiError,
  AuthenticationError,
  BadRequestError,
  CompanyEnrichError,
  ConnectionError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from '@companyenrich/sdk';

/** Turns expected failures into one readable line. */
export function describeError(error: unknown): string {
  if (error instanceof AuthenticationError) {
    return 'CompanyEnrich rejected the API key (401). Check COMPANYENRICH_API_KEY; keys are at https://companyenrich.com/dashboard';
  }
  if (error instanceof PaymentRequiredError) {
    return 'CompanyEnrich returned 402: the account is out of credits or the plan does not include this request.';
  }
  if (error instanceof PermissionDeniedError) {
    return `CompanyEnrich returned 403: ${error.detail ?? 'this API key may not make this request.'}`;
  }
  if (error instanceof RateLimitError) {
    return 'CompanyEnrich rate limit still exceeded after retries (429). Try again in a minute.';
  }
  if (error instanceof ValidationError || error instanceof BadRequestError) {
    const fields = Object.entries(error.errors ?? {}).map(([field, messages]) => `${field}: ${messages.join(' ')}`);
    return `CompanyEnrich rejected the request (${error.status}): ${[error.detail ?? error.title, ...fields].filter(Boolean).join('; ')}`;
  }
  if (error instanceof ApiError) {
    const trace = error.traceId ? ` (trace id ${error.traceId})` : '';
    return `CompanyEnrich API error ${error.status}: ${error.detail ?? error.title ?? 'no details'}${trace}`;
  }
  if (error instanceof CompanyEnrichError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * A paid call that got no response may still have been processed and billed. The ledger counts
 * it as spent, so the credit cap holds even then.
 */
export function mayHaveBeenCharged(error: unknown): boolean {
  return error instanceof TimeoutError || error instanceof ConnectionError;
}

/** Errors that will fail every following call too, so a run should stop instead of continuing. */
export function isFatal(error: unknown): boolean {
  return error instanceof AuthenticationError || error instanceof PaymentRequiredError || error instanceof PermissionDeniedError;
}
