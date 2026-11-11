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
import { UserFacingError } from './user-error';

const DASHBOARD = 'https://companyenrich.com/dashboard';

/** Turn any error into one line a user can act on. Unknown errors keep their message. */
export function describeError(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof AuthenticationError) {
    return `CompanyEnrich rejected the API key. Check COMPANYENRICH_API_KEY (keys: ${DASHBOARD}).`;
  }
  if (error instanceof PaymentRequiredError) {
    return `CompanyEnrich says this account is out of credits or the plan does not include this call (${DASHBOARD}).`;
  }
  if (error instanceof PermissionDeniedError) {
    return `This API key may not make that request: ${error.detail ?? error.message}`;
  }
  if (error instanceof RateLimitError) {
    return 'CompanyEnrich rate limit reached even after retries. Wait a minute or use fewer accounts.';
  }
  if (error instanceof ValidationError) {
    const fields = Object.entries(error.errors ?? {})
      .map(([field, messages]) => `${field}: ${messages.join(', ')}`)
      .join('; ');
    return `CompanyEnrich rejected the request: ${fields || error.detail || error.message}`;
  }
  if (error instanceof ApiError) {
    return `CompanyEnrich API error ${error.status}: ${error.detail ?? error.title ?? error.message}${error.traceId ? ` (trace ${error.traceId})` : ''}`;
  }
  if (error instanceof ConnectionError || error instanceof TimeoutError) {
    return `Could not reach CompanyEnrich: ${error.message}`;
  }
  if (error instanceof CompanyEnrichError) {
    // The SDK throws this for a missing key before any request is made.
    return error.message.includes('API key')
      ? `COMPANYENRICH_API_KEY is not set. Get a key at ${DASHBOARD}.`
      : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
