import {
  ApiError,
  AuthenticationError,
  ConnectionError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  TimeoutError,
} from '@companyenrich/sdk';

/** An expected problem the user can fix. The CLI prints its message without a stack trace. */
export class UserError extends Error {
  override name = 'UserError';
}

const DASHBOARD = 'https://companyenrich.com/dashboard';

/** One line for every expected failure, or null for a bug that deserves a stack trace. */
export function describeError(error: unknown): string | null {
  if (error instanceof UserError) return error.message;
  if (error instanceof AuthenticationError) {
    return `CompanyEnrich rejected the API key (401). Check COMPANYENRICH_API_KEY; keys are at ${DASHBOARD}`;
  }
  if (error instanceof PaymentRequiredError) {
    return `Not enough CompanyEnrich credits for this request (402). ${error.detail ?? ''} Top up at ${DASHBOARD} or enrich fewer domains.`.trim();
  }
  if (error instanceof PermissionDeniedError) {
    return `This API key is not allowed to make this request (403). ${error.detail ?? ''}`.trim();
  }
  if (error instanceof RateLimitError) {
    return 'CompanyEnrich rate limit reached (429) after retries. Wait a minute and re-run; finished lookups are cached.';
  }
  if (error instanceof ServerError) {
    return `CompanyEnrich returned a server error (${error.status}). Re-run later${error.traceId ? `; trace ID ${error.traceId}` : ''}.`;
  }
  if (error instanceof ApiError) {
    return `CompanyEnrich API error: ${error.message}${error.traceId ? ` (trace ID ${error.traceId})` : ''}`;
  }
  if (error instanceof TimeoutError) return `CompanyEnrich did not answer in time: ${error.message}`;
  if (error instanceof ConnectionError) return error.message;
  return null;
}
