import {
  ApiError,
  AuthenticationError,
  ConnectionError,
  NotFoundError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  TimeoutError,
} from '@companyenrich/sdk';

/** Thrown when a paid call would break the per-question or daily cap. Nothing was charged. */
export class BudgetError extends Error {
  override name = 'BudgetError';
}

/** Thrown when a paid call above the approval threshold arrives without an approval. */
export class ApprovalRequiredError extends Error {
  override name = 'ApprovalRequiredError';
}

/** One-line, user-facing description of an expected failure. */
export function describeError(error: unknown): string {
  if (error instanceof AuthenticationError) {
    return 'CompanyEnrich rejected the API key (401). Check COMPANYENRICH_API_KEY.';
  }
  if (error instanceof PaymentRequiredError) {
    return 'CompanyEnrich says the account is out of credits, or this feature is not in the plan (402).';
  }
  if (error instanceof PermissionDeniedError) {
    return 'This CompanyEnrich plan does not include that endpoint (403).';
  }
  if (error instanceof RateLimitError) {
    return 'CompanyEnrich rate limit reached (429). Try again in a minute.';
  }
  if (error instanceof NotFoundError) {
    return 'CompanyEnrich has no record for that (404).';
  }
  if (error instanceof ApiError) {
    return `CompanyEnrich returned ${error.status}: ${error.detail ?? error.title ?? error.message}`;
  }
  if (error instanceof TimeoutError || error instanceof ConnectionError) {
    return 'Could not reach CompanyEnrich (timeout or network error). Try again.';
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
