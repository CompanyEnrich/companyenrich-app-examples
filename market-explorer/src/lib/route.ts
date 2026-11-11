/**
 * Glue between Next.js route handlers and `handlers.ts`. One SDK client, one
 * cache, one upstream limiter, one credit budget and one per-address throttle
 * per server process. JSON in, JSON out, errors as `{ error }`. See
 * `client-ip.ts` for which address the throttle counts against.
 */
import { CompanyEnrich } from '@companyenrich/sdk';
import { LruCache } from './cache';
import { readConfig } from './config';
import { clientIp, type ProxySettings } from './client-ip';
import { MissingApiKeyError, errorResult, type HandlerResult } from './errors';
import { run, type Deps, type Handler, type RequestContext } from './handlers';
import { CreditBudget, SlidingWindowLimiter } from './spend';
import { UpstreamLimiter, limitedFetch } from './upstream';

const CACHE_ENTRIES = 2_000;
const CACHE_TTL_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;

/** Shared by every route: at most 4 CompanyEnrich requests in flight, 100 waiting. */
export const upstreamLimiter = new UpstreamLimiter(4, 100);

let deps: Deps | undefined;
let proxy: ProxySettings = { trustProxy: false, onVercel: false };

/** Reads settings on first use. The API key never leaves the server. */
export function getDeps(): Deps {
  if (deps) return deps;
  const config = readConfig();
  if (!config.apiKey) throw new MissingApiKeyError();
  proxy = { trustProxy: config.trustProxy, onVercel: config.onVercel };
  deps = {
    client: new CompanyEnrich({ apiKey: config.apiKey, timeoutMs: 30_000, fetch: limitedFetch(upstreamLimiter) }),
    cache: new LruCache<unknown>(CACHE_ENTRIES, CACHE_TTL_MS),
    paidSearchEnabled: config.paidSearchEnabled,
    budget: new CreditBudget(config.maxCreditsPerDay),
    paidSearchThrottle: new SlidingWindowLimiter(config.maxPaidSearchesPerIpPerHour, HOUR_MS),
  };
  return deps;
}

function toResponse({ status, body }: HandlerResult): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function respond(handler: Handler, request: Request, input: () => Promise<unknown> | unknown): Promise<Response> {
  try {
    const handlerDeps = getDeps();
    const context: RequestContext = { clientIp: clientIp(request.headers, proxy) };
    return toResponse(await run(handler, await input(), handlerDeps, context));
  } catch (error) {
    return toResponse(errorResult(error));
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** A POST route whose input is the JSON body. */
export function postRoute(handler: Handler) {
  return (request: Request) => respond(handler, request, () => readJson(request));
}

/** A GET route whose input is built from the URL. */
export function getRoute(handler: Handler, input: (url: URL) => unknown = () => undefined) {
  return (request: Request) => respond(handler, request, () => input(new URL(request.url)));
}
