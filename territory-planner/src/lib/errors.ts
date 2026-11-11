import {
  ApiError,
  AuthenticationError,
  CompanyEnrichError,
  ConnectionError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from '@companyenrich/sdk';

/** A problem with the user's input. The CLI prints the message without a stack trace. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** Turns an expected failure into one readable line. Returns undefined for real bugs. */
export function describeError(error: unknown): string | undefined {
  if (error instanceof UsageError) return error.message;
  if (error instanceof AuthenticationError) {
    return 'CompanyEnrich rejected the API key (401). Check COMPANYENRICH_API_KEY; keys are at https://companyenrich.com/dashboard.';
  }
  if (error instanceof PaymentRequiredError) {
    return `CompanyEnrich says the account is out of credits or the plan does not include this request (402): ${error.detail ?? error.message}`;
  }
  if (error instanceof PermissionDeniedError) {
    return `This API key may not make that request (403): ${error.detail ?? error.message}`;
  }
  if (error instanceof ValidationError) {
    const fields = Object.entries(error.errors ?? {})
      .map(([field, messages]) => `${field}: ${messages.join(' ')}`)
      .join('; ');
    return `CompanyEnrich rejected the query (422). ${fields || error.detail || error.message} Check the ICP file against https://docs.companyenrich.com.`;
  }
  if (error instanceof RateLimitError) {
    return 'CompanyEnrich is rate limiting this key and retries did not help. Wait a minute and run again; cached counts are reused.';
  }
  if (error instanceof ApiError) {
    const trace = error.traceId ? ` (trace id ${error.traceId})` : '';
    return `CompanyEnrich returned ${error.status}: ${error.detail ?? error.title ?? error.message}${trace}`;
  }
  if (error instanceof TimeoutError || error instanceof ConnectionError) {
    return `Could not reach CompanyEnrich: ${error.message}. Check your connection and run again; cached counts are reused.`;
  }
  if (error instanceof CompanyEnrichError) return error.message;
  return undefined;
}
