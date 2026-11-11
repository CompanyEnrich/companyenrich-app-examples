import {
  ApiError,
  AuthenticationError,
  BadRequestError,
  ConnectionError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  TimeoutError,
  ValidationError,
} from '@companyenrich/sdk';
import { ConfigError } from './client';

const DASHBOARD = 'https://companyenrich.com/dashboard';

/**
 * A company's workforce call was skipped because the run's confirmed credits
 * were used up, for example when a cached company expired after the estimate.
 */
export class CapReachedError extends Error {
  override name = 'CapReachedError';
  constructor() {
    super('The confirmed credit cap was reached.');
  }
}

/**
 * A request-level failure: an HTTP status for the route and one line for the user.
 * `unexpected` marks bugs worth logging; their details never reach the browser.
 */
export function toErrorResponse(error: unknown): { status: number; message: string; unexpected?: true } {
  if (error instanceof ConfigError) return { status: 500, message: error.message };
  if (error instanceof AuthenticationError) {
    return { status: 401, message: `CompanyEnrich rejected the API key. Check COMPANYENRICH_API_KEY (keys: ${DASHBOARD}).` };
  }
  if (error instanceof PaymentRequiredError) {
    return { status: 402, message: `This CompanyEnrich account is out of credits or its plan does not include this call (${DASHBOARD}).` };
  }
  if (error instanceof RateLimitError) {
    return { status: 429, message: 'CompanyEnrich rate limit reached even after retries. Wait a minute and try again.' };
  }
  if (error instanceof ValidationError || error instanceof BadRequestError) {
    const fields = Object.values(error.errors ?? {}).flat().join(' ');
    return { status: 400, message: `CompanyEnrich rejected the request: ${fields || error.detail || error.message}` };
  }
  if (error instanceof TimeoutError || error instanceof ConnectionError) {
    return { status: 504, message: 'Could not reach CompanyEnrich in time. Try again.' };
  }
  if (error instanceof ApiError) {
    const trace = error.traceId ? ` (trace ${error.traceId})` : '';
    return { status: 502, message: `CompanyEnrich API error ${error.status}: ${error.detail ?? error.title ?? error.message}${trace}` };
  }
  return { status: 500, message: 'Unexpected server error. Check the server log.', unexpected: true };
}

/** Errors that mean every later call would fail too, so the run stops instead of excluding companies one by one. */
export function isFatal(error: unknown): boolean {
  return error instanceof AuthenticationError || error instanceof ConfigError;
}

/**
 * Whether a failed paid call may still have been billed. An HTTP error response
 * means the call did not succeed, and only successful results are charged; a
 * timeout or dropped connection leaves it unknown, so the credits stay counted.
 */
export function mayHaveCharged(error: unknown): boolean {
  return error instanceof TimeoutError || error instanceof ConnectionError;
}

/** Why one company was left out of a run, as a lower-case fragment. */
export function exclusionReason(error: unknown): string {
  if (error instanceof CapReachedError) return 'its cached data expired after the estimate; run again to confirm the new cost';
  if (error instanceof PaymentRequiredError) return 'out of credits';
  if (error instanceof PermissionDeniedError) return 'this API key may not read workforce data';
  if (error instanceof RateLimitError) return 'rate limited, try again in a minute';
  if (error instanceof ValidationError || error instanceof BadRequestError) return 'CompanyEnrich rejected this domain';
  if (error instanceof TimeoutError || error instanceof ConnectionError) return 'CompanyEnrich did not respond in time';
  if (error instanceof ServerError) return 'CompanyEnrich server error, try again';
  if (error instanceof ApiError) return `CompanyEnrich API error ${error.status}`;
  return 'unexpected error';
}
