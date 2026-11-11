import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Approvals } from '../src/lib/approvals.js';
import { checkSpend, Ledger, needsApproval } from '../src/lib/budget.js';
import { LIMITS } from './fixtures.js';

describe('checkSpend', () => {
  const base = { questionSpent: 0, userSpentToday: 0, totalSpentToday: 0, limits: LIMITS };

  it('allows free calls even when every cap is used up', () => {
    expect(checkSpend({ ...base, estimate: 0, questionSpent: 50, userSpentToday: 200, totalSpentToday: 1000 })).toEqual({ ok: true });
  });

  it('allows spend exactly up to a cap', () => {
    expect(checkSpend({ ...base, estimate: 50 })).toEqual({ ok: true });
  });

  it('blocks spend over the per-question cap', () => {
    const check = checkSpend({ ...base, estimate: 20, questionSpent: 40 });
    expect(check).toEqual({ ok: false, reason: expect.stringContaining('per-question cap of 50 (40 already spent') });
  });

  it('blocks spend over the per-user daily cap', () => {
    expect(checkSpend({ ...base, estimate: 10, userSpentToday: 195 })).toMatchObject({ ok: false, reason: expect.stringContaining('your daily cap of 200') });
  });

  it('blocks spend over the daily cap for everyone together', () => {
    expect(checkSpend({ ...base, estimate: 10, totalSpentToday: 995 })).toMatchObject({ ok: false, reason: expect.stringContaining('for everyone together') });
  });
});

describe('needsApproval', () => {
  it('requires a click only above the threshold', () => {
    expect(needsApproval(10, LIMITS)).toBe(false);
    expect(needsApproval(11, LIMITS)).toBe(true);
  });
});

describe('Ledger', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tracks reserved and settled spend per user and in total', () => {
    const ledger = new Ledger();
    ledger.settle(ledger.reserve('U1', 10), 7);
    ledger.reserve('U2', 5);
    expect(ledger.spentToday('U1')).toBe(7);
    expect(ledger.totalToday()).toBe(12);
  });

  it('survives a restart through its file, but not past midnight UTC', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
    dirs.push(dir);
    const file = path.join(dir, 'state', 'ledger.json');
    let now = new Date('2026-11-11T23:59:00Z');
    new Ledger(file, () => now).reserve('U1', 25);

    expect(new Ledger(file, () => now).spentToday('U1')).toBe(25);
    now = new Date('2026-11-12T00:01:00Z');
    expect(new Ledger(file, () => now).spentToday('U1')).toBe(0);
  });

  it('rolls over in a long-running process', () => {
    let now = new Date('2026-11-11T12:00:00Z');
    const ledger = new Ledger(undefined, () => now);
    ledger.reserve('U1', 40);
    now = new Date('2026-11-12T12:00:00Z');
    expect(ledger.spentToday('U1')).toBe(0);
  });

  it("never lets yesterday's settlement refund today's spend", () => {
    let now = new Date('2026-11-11T23:59:59Z');
    const ledger = new Ledger(undefined, () => now);
    const yesterday = ledger.reserve('U1', 1);
    now = new Date('2026-11-12T00:00:01Z');
    ledger.reserve('U1', 1);
    ledger.settle(yesterday, 0);
    expect(ledger.spentToday('U1')).toBe(1);
    expect(checkSpend({ estimate: 1, questionSpent: 0, userSpentToday: ledger.spentToday('U1'), totalSpentToday: 0, limits: { ...LIMITS, dailyUserCap: 1 } }).ok).toBe(false);
  });

  it('counts a charge above yesterday\'s reservation today', () => {
    let now = new Date('2026-11-11T23:59:59Z');
    const ledger = new Ledger(undefined, () => now);
    const yesterday = ledger.reserve('U1', 2);
    now = new Date('2026-11-12T00:00:01Z');
    ledger.settle(yesterday, 5);
    expect(ledger.spentToday('U1')).toBe(3);
  });
});

describe('Approvals', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('only lets the requester decide', async () => {
    const approvals = new Approvals();
    const { id, decision } = approvals.request('U1', 'Fetch 5 people?');
    expect(approvals.resolve(id, 'U2', 'approved')).toEqual({ status: 'not-owner', ownerId: 'U1' });
    expect(approvals.resolve(id, 'U1', 'approved')).toEqual({ status: 'ok', summary: 'Fetch 5 people?' });
    await expect(decision).resolves.toBe('approved');
  });

  it('settles once: a second click finds nothing', async () => {
    const approvals = new Approvals();
    const { id, decision } = approvals.request('U1', 'x');
    approvals.resolve(id, 'U1', 'cancelled');
    expect(approvals.resolve(id, 'U1', 'approved')).toEqual({ status: 'not-found' });
    await expect(decision).resolves.toBe('cancelled');
    expect(approvals.size).toBe(0);
  });

  it('expires after the time limit', async () => {
    vi.useFakeTimers();
    const approvals = new Approvals(1000);
    const { id, decision } = approvals.request('U1', 'x');
    vi.advanceTimersByTime(1001);
    await expect(decision).resolves.toBe('expired');
    expect(approvals.resolve(id, 'U1', 'approved')).toEqual({ status: 'not-found' });
  });

  it('rejects unknown ids, such as one from before a restart', () => {
    expect(new Approvals().resolve('made-up', 'U1', 'approved')).toEqual({ status: 'not-found' });
  });
});
