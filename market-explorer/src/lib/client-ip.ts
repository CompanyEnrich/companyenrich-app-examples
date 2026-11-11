/**
 * Which address the per-client paid-search throttle counts against. Request
 * headers are written by the client unless a proxy you trust overwrites them, so
 * by default every caller shares one bucket and no header can reset the limit.
 */

export const SHARED_BUCKET = 'shared';

export interface ProxySettings {
  /** `TRUST_PROXY=1`: trust the right-most `X-Forwarded-For` hop, the one your proxy appended. */
  trustProxy: boolean;
  /** Running on Vercel, whose edge sets `x-vercel-forwarded-for` and drops client-supplied values. */
  onVercel: boolean;
}

export function clientIp(headers: Headers, { trustProxy, onVercel }: ProxySettings): string {
  if (onVercel) {
    const vercel = headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim();
    if (vercel) return vercel;
  }
  if (trustProxy) {
    // Entries to the left of the last hop are whatever the client sent; only the last one is the proxy's.
    const hops = headers.get('x-forwarded-for')?.split(',').map((hop) => hop.trim()).filter(Boolean) ?? [];
    const last = hops.at(-1);
    if (last) return last;
  }
  return SHARED_BUCKET;
}
