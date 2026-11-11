import { toErrorResponse } from './errors';

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function errorResponse(message: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: message, ...extra }, { status });
}

/**
 * Maps SDK and config errors to a status and one readable line. Unknown errors
 * are logged, not echoed. `extra` carries facts the client still needs, such as
 * the credits a run spent before it failed.
 */
export function failure(error: unknown, extra: Record<string, unknown> = {}): Response {
  const { status, message, unexpected } = toErrorResponse(error);
  if (unexpected) console.error(error);
  return errorResponse(message, status, extra);
}

/** The cost went up after the user confirmed (for example, a cached company expired). */
export function overConfirmed(what: string, credits: number, maxCredits: number, estimate: unknown): Response {
  return errorResponse(`${what} now costs up to ${credits} credits, more than the ${maxCredits} you confirmed.`, 409, {
    estimate,
  });
}

/** The process-wide MAX_CREDITS budget cannot cover this request. */
export function overBudget(credits: number, remaining: number): Response {
  return errorResponse(
    `This server may spend only ${remaining} more credits (MAX_CREDITS), and this request needs up to ${credits}. Raise MAX_CREDITS and restart the server.`,
    403,
  );
}
