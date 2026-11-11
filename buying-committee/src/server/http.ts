import {
  AuthenticationError,
  CompanyEnrichError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  ValidationError,
} from '@companyenrich/sdk';
import { z } from 'zod';
import { createClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { UserFacingError } from '@/lib/user-error';

/** Server-only: the API key is read here and never sent to the browser. */
export function serverClient() {
  if (!process.env.COMPANYENRICH_API_KEY) {
    throw new UserFacingError('COMPANYENRICH_API_KEY is not set on the server. Add it to .env.local (keys: https://companyenrich.com/dashboard).');
  }
  return createClient();
}

export async function readJson<Schema extends z.ZodType>(request: Request, schema: Schema): Promise<z.infer<Schema>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new UserFacingError('The request body must be JSON.');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Enum errors list every allowed value (200+ departments); keep the message to one line.
    const message = issue?.code === 'invalid_value' ? 'not an allowed value' : issue?.message;
    throw new UserFacingError(`Invalid request: ${issue ? `${issue.path.join('.') || 'body'}: ${message}` : 'unexpected shape'}`);
  }
  return parsed.data;
}

/**
 * Paid routes refuse to run unless the client explicitly confirmed the cost.
 * Checked before any API call, so `confirmed: false` never reaches CompanyEnrich.
 */
export function requireConfirmation(confirmed: boolean | undefined, cost: string): void {
  if (confirmed !== true) throw new UserFacingError(`Not confirmed: this request can spend ${cost}. Send "confirmed": true to proceed.`);
}

function statusFor(error: unknown): number {
  if (error instanceof UserFacingError || error instanceof ValidationError) return 400;
  if (error instanceof AuthenticationError) return 401;
  if (error instanceof PaymentRequiredError) return 402;
  if (error instanceof PermissionDeniedError) return 403;
  if (error instanceof RateLimitError) return 429;
  if (error instanceof CompanyEnrichError) return 502;
  return 500;
}

/** Expected failures get a one-line message; unexpected ones are logged server-side. */
export function errorResponse(error: unknown): Response {
  const status = statusFor(error);
  if (status === 500) console.error(error);
  return Response.json({ error: describeError(error) }, { status });
}
