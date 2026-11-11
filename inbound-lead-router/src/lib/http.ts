import { createHash, timingSafeEqual } from 'node:crypto';
import type { RateLimiter } from './rate-limit';

// Request guards shared by the API routes. They work on standard `Headers` and
// `ReadableStream`, so they are tested without starting Next.js.

export interface ApiRequest {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  /** What the rate limiter counts against; see `rateLimitKey`. */
  clientKey: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface GuardOptions {
  /** When set, requests must send it in `x-webhook-secret`. */
  secret: string | undefined;
  /**
   * Refuse to run without a secret. True in production unless ALLOW_UNAUTHENTICATED_WEBHOOK=1:
   * a webhook has no human to confirm spend, so authentication is its confirm step.
   */
  secretRequired: boolean;
  limiter: RateLimiter;
}

export function errorResponse(status: number, error: string, headers?: Record<string, string>): ApiResponse {
  return { status, body: { error }, headers };
}

/** Constant-time comparison. Hashing first makes the lengths equal, as timingSafeEqual requires. */
export function secretsMatch(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** Auth configuration, rate limit, then shared-secret auth. Returns a response to send, or null to continue. */
export function guard(request: ApiRequest, { secret, secretRequired, limiter }: GuardOptions): ApiResponse | null {
  if (secretRequired && !secret) {
    return errorResponse(503, 'INBOUND_WEBHOOK_SECRET is not set. Set it to accept leads in production, or set ALLOW_UNAUTHENTICATED_WEBHOOK=1 for a local demo.');
  }
  const limited = limiter.check(request.clientKey);
  if (!limited.allowed) {
    return errorResponse(429, `Too many requests. Try again in ${limited.retryAfterSeconds} s.`, {
      'Retry-After': String(limited.retryAfterSeconds),
    });
  }
  if (secret) {
    const given = request.headers.get('x-webhook-secret');
    if (!given || !secretsMatch(given, secret)) return errorResponse(401, 'Missing or wrong x-webhook-secret header.');
  }
  return null;
}

/**
 * Reads a JSON body of at most `maxBytes`, stopping as soon as the limit is passed
 * (a missing or false Content-Length cannot make it buffer more).
 */
export async function readJsonBody(request: ApiRequest, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false; response: ApiResponse }> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(contentType)) {
    return { ok: false, response: errorResponse(415, 'Send the body as JSON with Content-Type: application/json.') };
  }
  const tooLarge = { ok: false as const, response: errorResponse(413, `Body is larger than ${maxBytes} bytes.`) };
  const declared = Number(request.headers.get('content-length'));
  if (declared > maxBytes) return tooLarge;
  if (!request.body) return { ok: false, response: errorResponse(400, 'Body is empty.') };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return tooLarge;
    }
    chunks.push(value);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: errorResponse(400, 'Body is not valid JSON.') };
  }
}

/**
 * The rate-limit key for a request. Any client can write X-Forwarded-For, so by
 * default every client shares one bucket. Behind a proxy you control, set
 * TRUST_PROXY=1 to count per address: the right-most hop, which your proxy appended.
 */
export function rateLimitKey(headers: Headers, trustProxy: boolean): string {
  if (!trustProxy) return 'all-clients';
  const hops = (headers.get('x-forwarded-for') ?? '').split(',').map((hop) => hop.trim()).filter(Boolean);
  return hops.at(-1) ?? 'unknown';
}
