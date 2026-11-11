// Rate limits are only as good as the client identity behind them. A resolver
// must read the IP from a header that a trusted layer sets, never from one the
// client controls. `next start` exposed directly, for example, passes a
// client-sent X-Forwarded-For through unchanged, so no header is trustworthy
// there and the handler falls back to one shared bucket.

export type ClientIpResolver = (request: Request) => string | null;

/**
 * Behind `trustedProxies` reverse proxies that you run, each appending the
 * address it saw to X-Forwarded-For: the client is that many entries from the
 * right. Entries further left came from the client and may be forged.
 */
export function forwardedFor(trustedProxies: number): ClientIpResolver {
  return (request) => {
    const hops = (request.headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean);
    return trustedProxies > 0 ? (hops[hops.length - trustedProxies] ?? null) : null;
  };
}

/** On Vercel, which sets this header itself. */
export const vercelClientIp: ClientIpResolver = (request) =>
  request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() || null;

/** On Cloudflare (Workers, or any origin behind Cloudflare), which sets this header itself. */
export const cloudflareClientIp: ClientIpResolver = (request) => request.headers.get('cf-connecting-ip');
