/** Turns anything a handler throws into a status code and a one-line message. */
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
import { ConfigError } from './config';
import { UpstreamBusyError } from './upstream';

export interface HandlerResult {
  status: number;
  body: unknown;
}

/** The request body failed validation. */
export class InputError extends Error {
  override name = 'InputError';
}

export class MissingApiKeyError extends Error {
  override name = 'MissingApiKeyError';
  constructor() {
    super('COMPANYENRICH_API_KEY is not set.');
  }
}

const fail = (status: number, error: string): HandlerResult => ({ status, body: { error } });

export function errorResult(error: unknown): HandlerResult {
  if (error instanceof InputError) return fail(400, error.message);
  if (error instanceof MissingApiKeyError) {
    return fail(
      500,
      'COMPANYENRICH_API_KEY is not set. Add it to .env.local (keys: https://companyenrich.com/dashboard) and restart the server.',
    );
  }
  if (error instanceof ConfigError) return fail(500, error.message);
  if (error instanceof UpstreamBusyError) {
    return fail(503, 'The server is busy with other CompanyEnrich requests. Retry in a few seconds.');
  }
  if (error instanceof AuthenticationError) {
    return fail(401, 'CompanyEnrich rejected the API key. Check COMPANYENRICH_API_KEY and restart the server.');
  }
  if (error instanceof PaymentRequiredError) {
    return fail(402, 'Not enough credits, or your plan does not include this request.');
  }
  if (error instanceof PermissionDeniedError) return fail(403, 'This API key is not allowed to make this request.');
  if (error instanceof RateLimitError) return fail(429, 'CompanyEnrich is rate limiting requests. Wait a few seconds and retry.');
  if (error instanceof BadRequestError || error instanceof ValidationError) {
    const fields = error.errors ? ` (${Object.keys(error.errors).join(', ')})` : '';
    return fail(400, `CompanyEnrich rejected the request: ${error.detail ?? error.title ?? 'invalid input'}${fields}`);
  }
  if (error instanceof ConnectionError || error instanceof TimeoutError) {
    return fail(502, 'Could not reach the CompanyEnrich API. Check the network and retry.');
  }
  if (error instanceof ServerError || error instanceof ApiError) {
    const trace = error.traceId ? ` Trace id: ${error.traceId}.` : '';
    return fail(502, `CompanyEnrich returned an error (${error.status}).${trace}`);
  }
  console.error(error);
  return fail(500, 'Unexpected server error. See the server log.');
}
