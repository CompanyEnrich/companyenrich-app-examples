import { forwardedFor, vercelClientIp, type ClientIpResolver } from '../../../src/server/client-ip';
import { createCompanyHandler } from '../../../src/server/handler';

// Rate limits need a client IP the visitor cannot forge. Vercel sets one. Behind
// reverse proxies you run, set TRUST_PROXY to how many of them append to
// X-Forwarded-For. Otherwise (for example `next start` exposed directly, which
// passes a client-sent X-Forwarded-For through) all visitors share one bucket.
function clientIpResolver(): ClientIpResolver | undefined {
  if (process.env.VERCEL) return vercelClientIp;
  const trustedProxies = Number(process.env.TRUST_PROXY);
  return Number.isInteger(trustedProxies) && trustedProxies > 0 ? forwardedFor(trustedProxies) : undefined;
}

// One handler per server process, so its cache and limits persist between
// requests. The key never leaves the server.
const handler = createCompanyHandler({
  apiKey: process.env.COMPANYENRICH_API_KEY,
  cacheTtlMs: 24 * 60 * 60 * 1000,
  clientIp: clientIpResolver(),
});

export async function GET(request: Request): Promise<Response> {
  return handler(request);
}
