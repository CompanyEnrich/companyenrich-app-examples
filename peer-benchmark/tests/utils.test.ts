import { describe, expect, it } from 'vitest';
import { CreditAllowance, lookalikeCost, workforceCost } from '@/lib/credits';
import { formatGrowth, formatMonth, formatRatio, formatShare, possessive } from '@/lib/format';
import { createLimiter } from '@/lib/limiter';
import { linearScale } from '@/lib/scale';
import { TtlCache } from '@/lib/ttl-cache';

describe('TtlCache', () => {
  it('expires entries after the TTL', () => {
    let now = 0;
    const cache = new TtlCache<string>(1000, () => now);
    cache.set('a', 'value');
    now = 999;
    expect(cache.get('a')).toBe('value');
    now = 1000;
    expect(cache.has('a')).toBe(false);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const cache = new TtlCache<number>(1000);
    let loads = 0;
    const load = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 42;
    };
    const [first, second] = await Promise.all([cache.getOrLoad('k', load), cache.getOrLoad('k', load)]);
    expect(loads).toBe(1);
    expect([first.source, second.source]).toEqual(['loaded', 'in-flight']);
    expect((await cache.getOrLoad('k', load)).source).toBe('cache');
  });

  it('does not cache failures', async () => {
    const cache = new TtlCache<number>(1000);
    await expect(cache.getOrLoad('k', async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect((await cache.getOrLoad('k', async () => 7)).value).toBe(7);
  });
});

describe('createLimiter', () => {
  it('never runs more than the limit at once, across all callers', async () => {
    const limit = createLimiter(4);
    let running = 0;
    let peak = 0;
    const task = (ms: number) =>
      limit(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, ms));
        running -= 1;
        return ms;
      });
    // Two independent batches share the same limiter.
    const [first, second] = await Promise.all([Promise.all([5, 1, 4, 2, 3].map(task)), Promise.all([1, 2, 3, 4].map(task))]);
    expect(first).toEqual([5, 1, 4, 2, 3]);
    expect(second).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(4);
  });

  it('frees the slot when a task fails', async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await limit(async () => 'next')).toBe('next');
  });
});

describe('credits', () => {
  it('bills an empty lookalike search as one result', () => {
    expect(lookalikeCost(3)).toBe(15);
    expect(lookalikeCost(0)).toBe(5);
    expect(workforceCost(4)).toBe(4);
  });

  it('refuses a claim that would pass the limit, and takes refunds back', () => {
    const allowance = new CreditAllowance(3);
    expect(allowance.take(2)).toBe(true);
    expect(allowance.take(2)).toBe(false);
    expect(allowance.spent).toBe(2);
    allowance.refund(1);
    expect(allowance.remaining).toBe(2);
    expect(allowance.take(2)).toBe(true);
    expect(allowance.remaining).toBe(0);
  });
});

describe('format', () => {
  it('formats shares, growth, ratios and months', () => {
    expect(formatShare(0.0821)).toBe('8.2%');
    expect(formatShare(0.174)).toBe('17%');
    expect(formatShare(0)).toBe('0%');
    expect(formatGrowth(0.218)).toBe('+22%');
    expect(formatGrowth(-0.05)).toBe('-5%');
    expect(formatGrowth(0.004)).toBe('+0.4%');
    expect(formatGrowth(0.0001)).toBe('0%');
    expect(formatRatio(2.06)).toBe('2.1×');
    expect(formatMonth('2025-12-01')).toBe('Dec 2025');
    expect(possessive('Hotjar')).toBe("Hotjar's");
    expect(possessive('Atlassians')).toBe("Atlassians'");
  });
});

describe('linearScale', () => {
  it('rounds the axis to clean ticks that include zero', () => {
    const scale = linearScale([0.03, 0.42, 0.18]);
    expect(scale.min).toBe(0);
    expect(scale.max).toBeCloseTo(0.5);
    expect(scale.ticks.map((tick) => Math.round(tick * 100))).toEqual([0, 10, 20, 30, 40, 50]);
    expect(scale.position(0.25)).toBeCloseTo(50);
  });

  it('spans negative values and clamps past the limits', () => {
    const scale = linearScale([-0.12, 0.3, 5], { limits: [-1, 2] });
    expect(scale.min).toBeLessThan(0);
    expect(scale.max).toBe(2);
    expect(scale.isClamped(5)).toBe(true);
    expect(scale.position(5)).toBe(100);
    expect(scale.isClamped(0.3)).toBe(false);
  });

  it('survives empty or flat data', () => {
    expect(linearScale([]).ticks.length).toBeGreaterThan(1);
    expect(linearScale([0, 0]).max).toBeGreaterThan(0);
  });
});
