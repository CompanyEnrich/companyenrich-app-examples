import Anthropic from '@anthropic-ai/sdk';
import {
  ApiError,
  AuthenticationError,
  CompanyEnrichError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
} from '@companyenrich/sdk';
import { AgentError } from './agent';
import { InputError } from './input';
import { UsageError } from './options';

/** An expected failure, such as an unknown domain, that should end the run with a one-line message. */
export class BriefError extends Error {
  override name = 'BriefError';
}

/** One line for every error we expect. Returns undefined for bugs, so the caller can show the stack. */
export function describeError(error: unknown): string | undefined {
  if (error instanceof UsageError || error instanceof InputError || error instanceof AgentError || error instanceof BriefError) {
    return error.message;
  }

  if (error instanceof AuthenticationError) {
    return 'CompanyEnrich rejected the API key (401). Check COMPANYENRICH_API_KEY; keys are at https://companyenrich.com/dashboard';
  }
  if (error instanceof PaymentRequiredError) {
    return `CompanyEnrich: out of credits, or this request is not in your plan (402). ${error.detail ?? ''}`.trim();
  }
  if (error instanceof PermissionDeniedError) {
    return `CompanyEnrich: this API key may not make that request (403). ${error.detail ?? ''}`.trim();
  }
  if (error instanceof RateLimitError) return 'CompanyEnrich rate limit hit, even after retries. Wait a minute and try again.';
  if (error instanceof ApiError) {
    const trace = error.traceId ? ` (trace id ${error.traceId})` : '';
    return `CompanyEnrich API error ${error.status}: ${error.detail ?? error.title ?? error.message}${trace}`;
  }
  // Missing key, connection failures and timeouts.
  if (error instanceof CompanyEnrichError) return `CompanyEnrich: ${error.message}`;

  if (error instanceof Anthropic.AuthenticationError) return 'Anthropic rejected ANTHROPIC_API_KEY (401). Check the key, or use --mode pipeline.';
  if (error instanceof Anthropic.APIError) return `Claude API error${error.status ? ` ${error.status}` : ''}: ${error.message}`;

  return undefined;
}
