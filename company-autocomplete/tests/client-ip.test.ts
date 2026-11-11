import { describe, expect, it } from 'vitest';
import { cloudflareClientIp, forwardedFor, vercelClientIp } from '../src/server/client-ip';

const request = (headers: Record<string, string>) => new Request('http://localhost/api/company', { headers });

describe('forwardedFor', () => {
  const chain = request({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 10.0.0.2' });

  it('picks the hop added by the outermost trusted proxy', () => {
    expect(forwardedFor(1)(chain)).toBe('10.0.0.2');
    expect(forwardedFor(2)(chain)).toBe('203.0.113.7');
  });

  it('returns null when the chain is shorter than the trusted proxies, or none are trusted', () => {
    expect(forwardedFor(4)(chain)).toBeNull();
    expect(forwardedFor(0)(chain)).toBeNull();
    expect(forwardedFor(1)(request({}))).toBeNull();
  });
});

describe('platform resolvers', () => {
  it('read only the header their platform sets', () => {
    const forged = { 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '6.6.6.6' };
    expect(vercelClientIp(request({ ...forged, 'x-vercel-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9');
    expect(vercelClientIp(request(forged))).toBeNull();
    expect(cloudflareClientIp(request({ ...forged, 'cf-connecting-ip': '203.0.113.10' }))).toBe('203.0.113.10');
    expect(cloudflareClientIp(request(forged))).toBeNull();
  });
});
