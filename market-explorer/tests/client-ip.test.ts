import { describe, expect, it } from 'vitest';
import { SHARED_BUCKET, clientIp, type ProxySettings } from '@/lib/client-ip';
import { readConfig } from '@/lib/config';
import * as handlers from '@/lib/handlers';
import { run } from '@/lib/handlers';
import { SlidingWindowLimiter } from '@/lib/spend';
import { fakeClient, testDeps } from './helpers';

const DEFAULT: ProxySettings = { trustProxy: false, onVercel: false };
const headers = (values: Record<string, string>) => new Headers(values);

describe('clientIp', () => {
  it('ignores forwarding headers by default and uses one shared bucket', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' }), DEFAULT)).toBe(SHARED_BUCKET);
    expect(clientIp(headers({ 'x-vercel-forwarded-for': '1.2.3.4' }), DEFAULT)).toBe(SHARED_BUCKET);
  });

  it('with TRUST_PROXY uses the right-most hop, the one the proxy appended', () => {
    const trusted = { trustProxy: true, onVercel: false };
    expect(clientIp(headers({ 'x-forwarded-for': 'spoofed, 10.0.0.1, 203.0.113.7' }), trusted)).toBe('203.0.113.7');
    expect(clientIp(headers({}), trusted)).toBe(SHARED_BUCKET);
  });

  it('on Vercel uses the platform header only', () => {
    const vercel = { trustProxy: false, onVercel: true };
    expect(clientIp(headers({ 'x-vercel-forwarded-for': '198.51.100.4', 'x-forwarded-for': 'spoofed' }), vercel)).toBe(
      '198.51.100.4',
    );
    expect(clientIp(headers({ 'x-forwarded-for': 'spoofed' }), vercel)).toBe(SHARED_BUCKET);
  });

  it('reads the settings from the environment', () => {
    expect(readConfig({})).toMatchObject({ trustProxy: false, onVercel: false });
    expect(readConfig({ TRUST_PROXY: '1', VERCEL: '1' })).toMatchObject({ trustProxy: true, onVercel: true });
  });
});

describe('spoofed forwarding headers cannot reset the paid-search limit', () => {
  const routes = {
    'POST /v2/companies/search/count': () => ({ body: { count: 5, total: 5 } }),
    'POST /v2/companies/search': () => ({ body: { items: [] } }),
  };
  const body = { filter: { country: ['DE'] }, pageSize: 3, confirm: true };

  async function attempts(proxy: ProxySettings, forwardedFor: (i: number) => string) {
    const { client, calls } = fakeClient(routes);
    const deps = testDeps(client, { paidSearchThrottle: new SlidingWindowLimiter(2, 60 * 60_000) });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const context = { clientIp: clientIp(headers({ 'x-forwarded-for': forwardedFor(i), 'x-real-ip': `9.9.9.${i}` }), proxy) };
      statuses.push((await run(handlers.search, body, deps, context)).status);
    }
    return { statuses, paidCalls: calls.filter((c) => c.path === '/v2/companies/search').length };
  }

  it('by default, a new X-Forwarded-For on every request still hits the same limit', async () => {
    const { statuses, paidCalls } = await attempts(DEFAULT, (i) => `203.0.113.${i}`);
    expect(statuses).toEqual([200, 200, 429, 429, 429]);
    expect(paidCalls).toBe(2);
  });

  it('behind a trusted proxy, forging the left-most entries does not help', async () => {
    const { statuses, paidCalls } = await attempts({ trustProxy: true, onVercel: false }, (i) => `1.1.1.${i}, 203.0.113.7`);
    expect(statuses).toEqual([200, 200, 429, 429, 429]);
    expect(paidCalls).toBe(2);
  });
});
