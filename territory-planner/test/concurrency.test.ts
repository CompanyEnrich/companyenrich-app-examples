import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../src/lib/concurrency.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  it('keeps input order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapWithConcurrency([5, 1, 4, 2, 3, 1, 2], 3, async (value) => {
      running++;
      peak = Math.max(peak, running);
      await sleep(value);
      running--;
      return value * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30, 10, 20]);
    expect(peak).toBe(3);
  });

  it('lets running calls finish before rejecting, and starts no new ones', async () => {
    const finished: number[] = [];
    const started: number[] = [];
    const run = mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 4, async (value) => {
      started.push(value);
      if (value === 0) throw new Error('first call failed');
      await sleep(20);
      finished.push(value);
      return value;
    });
    await expect(run).rejects.toThrow('first call failed');
    // Calls 1-3 were already in flight when call 0 failed: they complete before the rejection.
    expect(finished.sort()).toEqual([1, 2, 3]);
    expect(started.sort()).toEqual([0, 1, 2, 3]);
  });
});
