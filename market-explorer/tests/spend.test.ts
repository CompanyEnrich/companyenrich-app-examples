import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_MAX_CREDITS_PER_DAY, readConfig } from '@/lib/config';
import { CreditBudget, SlidingWindowLimiter } from '@/lib/spend';

describe('CreditBudget', () => {
  it('reserves up to the daily cap and refuses beyond it', () => {
    const budget = new CreditBudget(25, () => Date.parse('2026-11-11T10:00:00Z'));
    expect(budget.reserve(10)).not.toBeNull();
    expect(budget.reserve(10)).not.toBeNull();
    expect(budget.reserve(10)).toBeNull();
    expect(budget.remaining()).toBe(5);
    expect(budget.reserve(5)).not.toBeNull();
    expect(budget.remaining()).toBe(0);
  });

  it('refunds the unused part of a reservation, never more', () => {
    const budget = new CreditBudget(20);
    const reservation = budget.reserve(10)!;
    budget.settle(reservation, 3);
    expect(budget.remaining()).toBe(17);
    const other = budget.reserve(10)!;
    budget.settle(other, 50);
    expect(budget.remaining()).toBe(7);
  });

  it('starts a fresh budget each UTC day and ignores settlements from yesterday', () => {
    let now = Date.parse('2026-11-11T23:59:00Z');
    const budget = new CreditBudget(10, () => now);
    const yesterday = budget.reserve(10)!;
    expect(budget.reserve(1)).toBeNull();
    now = Date.parse('2026-11-12T00:01:00Z');
    expect(budget.remaining()).toBe(10);
    budget.settle(yesterday, 0);
    expect(budget.remaining()).toBe(10);
  });

  it('a cap of 0 refuses every paid call', () => {
    expect(new CreditBudget(0).reserve(1)).toBeNull();
  });
});

describe('SlidingWindowLimiter', () => {
  it('allows `limit` events per key per window', () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(2, 1_000, () => now);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterMs: 1_000 });
    expect(limiter.take('b').allowed).toBe(true);
    now = 1_000;
    expect(limiter.take('a').allowed).toBe(true);
  });

  it('keeps memory bounded', () => {
    const limiter = new SlidingWindowLimiter(1, 1_000, () => 0, 3);
    for (const key of ['a', 'b', 'c', 'd']) limiter.take(key);
    // "a" was forgotten, so it gets a fresh allowance.
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('d').allowed).toBe(false);
  });
});

describe('readConfig', () => {
  it('is free-only and capped by default', () => {
    const config = readConfig({ COMPANYENRICH_API_KEY: ' key ' });
    expect(config).toEqual({
      apiKey: 'key',
      paidSearchEnabled: false,
      maxCreditsPerDay: DEFAULT_MAX_CREDITS_PER_DAY,
      maxPaidSearchesPerIpPerHour: 5,
      trustProxy: false,
      onVercel: false,
    });
  });

  it('enables paid search only for an explicit "true"', () => {
    expect(readConfig({ ENABLE_PAID_SEARCH: 'true' }).paidSearchEnabled).toBe(true);
    expect(readConfig({ ENABLE_PAID_SEARCH: 'TRUE' }).paidSearchEnabled).toBe(true);
    expect(readConfig({ ENABLE_PAID_SEARCH: '1' }).paidSearchEnabled).toBe(false);
    expect(readConfig({ ENABLE_PAID_SEARCH: 'false' }).paidSearchEnabled).toBe(false);
  });

  it('reads limits and rejects malformed ones with the variable name', () => {
    expect(readConfig({ SEARCH_MAX_CREDITS_PER_DAY: '0', SEARCH_MAX_PER_IP_PER_HOUR: '2' })).toMatchObject({
      maxCreditsPerDay: 0,
      maxPaidSearchesPerIpPerHour: 2,
    });
    expect(() => readConfig({ SEARCH_MAX_CREDITS_PER_DAY: '-5' })).toThrow(ConfigError);
    expect(() => readConfig({ SEARCH_MAX_PER_IP_PER_HOUR: 'lots' })).toThrow(/SEARCH_MAX_PER_IP_PER_HOUR/);
  });
});
