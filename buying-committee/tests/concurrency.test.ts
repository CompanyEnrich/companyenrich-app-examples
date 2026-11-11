import { describe, expect, it } from 'vitest';
import { createLimiter, mapWithConcurrency } from '../src/lib/concurrency';

describe('createLimiter', () => {
  it('caps nested callers at the shared limit and keeps every result', async () => {
    const limit = createLimiter(4);
    let active = 0;
    let peak = 0;
    const work = (value: number) =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        return value;
      });

    // Four outer workers, each fanning out with Promise.all: still at most 4 at once.
    const results = await mapWithConcurrency([0, 1, 2, 3], 4, (outer) => Promise.all([0, 1, 2].map((inner) => work(outer * 3 + inner))));
    expect(results.flat()).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(peak).toBe(4);
  });
});
