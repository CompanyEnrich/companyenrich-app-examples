import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TtlCache } from '../src/lib/cache';
import { DailyCreditLedger, LeadBudget } from '../src/lib/credits';
import { tempDir } from './helpers';

describe('TtlCache', () => {
  it('expires entries after the TTL', () => {
    let now = 0;
    const cache = new TtlCache<string>({ ttlMs: 1000, now: () => now });
    cache.set('a', 'x');
    now = 999;
    expect(cache.get('a')?.value).toBe('x');
    now = 1000;
    expect(cache.get('a')).toBeUndefined();
  });

  it('persists to disk and picks up writes from another instance', () => {
    const file = join(tempDir(), 'cache.json');
    const web = new TtlCache<number>({ ttlMs: 60_000, file });
    const cli = new TtlCache<number>({ ttlMs: 60_000, file });
    expect(web.get('k')).toBeUndefined();
    cli.set('k', 42);
    expect(web.get('k')?.value).toBe(42);
  });

  it('ignores an entry whose stored key does not match the lookup key', () => {
    const file = join(tempDir(), 'cache.json');
    writeFileSync(file, JSON.stringify({ 'acme.example': { key: 'other.example', value: 'wrong company', storedAt: Date.now() } }));
    expect(new TtlCache<string>({ ttlMs: 60_000, file }).get('acme.example')).toBeUndefined();
  });

  it('drops the oldest entries beyond maxEntries', () => {
    const cache = new TtlCache<number>({ ttlMs: 60_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')?.value).toBe(3);
  });
});

describe('DailyCreditLedger', () => {
  it('reserves against the cap, settles to the real cost and resets each UTC day', () => {
    let now = new Date('2026-11-11T20:00:00Z');
    const ledger = new DailyCreditLedger(10, () => now);
    const first = ledger.reserve(9);
    expect(first.ok).toBe(true);
    expect(ledger.reserve(2).ok).toBe(false); // two concurrent requests cannot both fit
    if (first.ok) ledger.settle(first.hold, 3); // the call cost less than its worst case
    expect(ledger.remaining()).toBe(7);
    const miss = ledger.reserve(3);
    if (miss.ok) ledger.settle(miss.hold, 0); // a 404 releases its reservation
    expect(ledger.remaining()).toBe(7);
    now = new Date('2026-11-12T00:01:00Z');
    expect(ledger.remaining()).toBe(10);
  });

  it('ignores a release from before midnight, so it cannot free today\'s credits', () => {
    let now = new Date('2026-11-11T23:59:00Z');
    const ledger = new DailyCreditLedger(3, () => now);
    const yesterday = ledger.reserve(3);
    now = new Date('2026-11-12T00:00:30Z');
    expect(ledger.reserve(3).ok).toBe(true);
    if (yesterday.ok) ledger.settle(yesterday.hold, 0);
    expect(ledger.remaining()).toBe(0);
    expect(ledger.reserve(3).ok).toBe(false);
  });
});

describe('LeadBudget', () => {
  it('stops one lead at its own cap even when the daily cap has room', () => {
    const budget = new LeadBudget(new DailyCreditLedger(100), 10);
    const enrich = budget.reserve(3);
    expect(enrich.ok).toBe(true);
    expect(budget.reserve(8)).toEqual({ ok: false, reason: expect.stringContaining('MAX_CREDITS_PER_LEAD (10)') });
    expect(budget.reserve(6).ok).toBe(true);
  });
});
