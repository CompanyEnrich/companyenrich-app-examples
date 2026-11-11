import {
  ApiError,
  AuthenticationError,
  BadRequestError,
  CompanyEnrichError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  ValidationError,
} from '@companyenrich/sdk';

/** Turns expected failures into one readable line. Unknown errors keep their message. */
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
    const detail =
      [error.detail ?? error.title, ...fields].filter(Boolean).join('; ') ||
      'check the filter values in the config against https://docs.companyenrich.com';
    return `CompanyEnrich rejected the request (${error.status}): ${detail}`;
  }
  if (error instanceof ApiError) {
    const trace = error.traceId ? ` (trace id ${error.traceId})` : '';
    return `CompanyEnrich API error ${error.status}: ${error.detail ?? error.title ?? 'no details'}${trace}`;
  }
  if (error instanceof CompanyEnrichError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
