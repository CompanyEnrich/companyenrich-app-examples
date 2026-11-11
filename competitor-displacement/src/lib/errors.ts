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

/** An expected problem with the input; the CLI prints the message without a stack trace. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** Expected failures become one clear line. Returns undefined for real bugs, which keep their stack trace. */
export function describeError(error: unknown): string | undefined {
  if (error instanceof UsageError) return error.message;
  if (error instanceof AuthenticationError) {
    return 'CompanyEnrich rejected the API key (401). Check COMPANYENRICH_API_KEY; keys are at https://companyenrich.com/dashboard';
  }
  if (error instanceof PaymentRequiredError) return `Not enough credits, or the plan does not include this request (402). ${error.detail ?? ''}`.trim();
  if (error instanceof PermissionDeniedError) return `The plan does not allow this request (403). ${error.detail ?? ''}`.trim();
  if (error instanceof RateLimitError) return 'Rate limited (429) even after retries. Wait a minute and run again.';
  if (error instanceof BadRequestError || error instanceof ValidationError) {
    const fields = Object.entries(error.errors ?? {}).map(([field, messages]) => `${field}: ${messages.join(' ')}`);
    return `The API rejected the request (${error.status}): ${[error.detail ?? error.title ?? 'invalid request', ...fields].join('; ')}`;
  }
  if (error instanceof ApiError) return `CompanyEnrich API error ${error.status}: ${error.detail ?? error.title ?? 'no detail'} (trace ${error.traceId ?? 'n/a'})`;
  if (error instanceof CompanyEnrichError) return `Could not reach CompanyEnrich: ${error.message}`; // connection problems and timeouts
  return undefined;
}
