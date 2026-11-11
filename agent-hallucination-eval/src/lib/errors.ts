import Anthropic from '@anthropic-ai/sdk';
import {
  ApiError,
  AuthenticationError,
  ConnectionError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  TimeoutError,
} from '@companyenrich/sdk';

/** A problem with the user's input or setup, reported as one line without a stack trace. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** Turns an expected failure from either SDK into one readable line. */
export function describeError(error: unknown): string {
  if (error instanceof UsageError) return error.message;

  if (error instanceof AuthenticationError) {
    return 'CompanyEnrich rejected the API key (401). Check COMPANYENRICH_API_KEY; keys are at https://companyenrich.com/dashboard';
  }
  if (error instanceof PaymentRequiredError) {
    return 'CompanyEnrich says the account is out of credits or the plan does not include this request (402).';
  }
  if (error instanceof PermissionDeniedError) return 'CompanyEnrich: this API key may not make this request (403).';
  if (error instanceof RateLimitError) return 'CompanyEnrich rate limit still hit after retries (429). Wait a minute and try again.';
  if (error instanceof ApiError) return `CompanyEnrich API error ${error.status}: ${error.detail ?? error.title ?? error.message}`;
  if (error instanceof ConnectionError || error instanceof TimeoutError) {
    return `Could not reach CompanyEnrich: ${error.message}`;
  }

  if (error instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY.';
  if (error instanceof Anthropic.PermissionDeniedError) return 'Anthropic: this API key may not use this model (403).';
  if (error instanceof Anthropic.RateLimitError) return 'Anthropic rate limit still hit after retries (429).';
  if (error instanceof Anthropic.APIError) return `Anthropic API error ${error.status ?? ''}: ${error.message}`.trim();

  return error instanceof Error ? error.message : String(error);
}

/** Errors that would fail every remaining question too, so a run stops instead of recording them one by one. */
export function isFatal(error: unknown): boolean {
  return (
    error instanceof UsageError ||
    error instanceof AuthenticationError ||
    error instanceof PaymentRequiredError ||
    error instanceof PermissionDeniedError ||
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  );
}
