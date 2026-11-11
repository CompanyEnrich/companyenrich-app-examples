import { describe, expect, it } from 'vitest';
import * as handlers from '@/lib/handlers';
import { run } from '@/lib/handlers';
import { UpstreamBusyError, UpstreamLimiter } from '@/lib/upstream';
import { fakeClient, testDeps } from './helpers';

const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));

describe('UpstreamLimiter', () => {
  it('caps concurrency across independent callers', async () => {
    const limiter = new UpstreamLimiter(4, 100);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await tick(2);
      active--;
    };
    await Promise.all(Array.from({ length: 20 }, () => limiter.run(task)));
    expect(peak).toBe(4);
    expect(limiter.inFlight).toBe(0);
  });

  it('refuses work beyond the queue cap instead of piling it up', async () => {
    const limiter = new UpstreamLimiter(1, 2);
    const slow = () => tick(5);
    const accepted = [limiter.run(slow), limiter.run(slow), limiter.run(slow)];
    await expect(limiter.run(slow)).rejects.toBeInstanceOf(UpstreamBusyError);
    await Promise.all(accepted);
  });

  it('drops a queued request when its signal aborts', async () => {
    const limiter = new UpstreamLimiter(1, 10);
    const first = limiter.run(() => tick(5));
    const controller = new AbortController();
    const queued = limiter.run(() => tick(1), controller.signal);
    expect(limiter.waiting).toBe(1);
    controller.abort(new Error('timed out'));
    await expect(queued).rejects.toThrow('timed out');
    expect(limiter.waiting).toBe(0);
    await first;
  });
});

describe('shared upstream limit across routes', () => {
  it('keeps three concurrent grids plus other routes at 4 requests in flight', async () => {
    const limiter = new UpstreamLimiter(4, 100);
    const { client, calls, stats } = fakeClient(
      {
        'POST /v2/companies/search/count': () => ({ body: { count: 1, total: 1 } }),
        'GET /v2/technologies/autocomplete': () => ({ body: { items: ['stripe'] } }),
      },
      limiter,
      3,
    );
    const deps = testDeps(client);
    const grid = (category: string) =>
      run(
        handlers.grid,
        {
          filter: { categories: [category] },
          rows: { dimension: 'country', values: ['US', 'DE', 'FR', 'GB'] },
          columns: { dimension: 'employees', values: ['1-10', '11-50', '51-200', '201-500'] },
        },
        deps,
      );
    const results = await Promise.all([
      grid('saas'),
      grid('b2b'),
      grid('b2c'),
      run(handlers.autocomplete, { kind: 'technologies', q: 'str' }, deps),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(calls).toHaveLength(49);
    // Without the shared limiter this reaches 12 or more (4 per grid).
    expect(stats.peak).toBe(4);
  });

  it('answers 503 with a clear message when the queue is full', async () => {
    const limiter = new UpstreamLimiter(1, 0);
    const { client } = fakeClient({ 'POST /v2/companies/search/count': () => ({ body: { count: 1, total: 1 } }) }, limiter);
    const deps = testDeps(client);
    const blocker = limiter.run(() => tick(20));
    const result = await run(handlers.count, { filter: { country: ['US'] } }, deps);
    expect(result).toEqual({
      status: 503,
      body: { error: 'The server is busy with other CompanyEnrich requests. Retry in a few seconds.' },
    });
    await blocker;
  });
});
