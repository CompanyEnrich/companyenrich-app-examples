import { describe, expect, it } from 'vitest';
import { createLimiter } from '../src/lib/concurrency.js';

describe('createLimiter', () => {
  it('never runs more than the cap at once, across nested callers', async () => {
    const limit = createLimiter(4);
    let active = 0;
    let peak = 0;
    const task = () =>
      limit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      });

    // Recursion shaped like the account bisection: every level waits on calls through one limiter.
    const tree = async (depth: number): Promise<void> => {
      await task();
      if (depth > 0) await Promise.all([tree(depth - 1), tree(depth - 1), tree(depth - 1)]);
    };
    await Promise.all([tree(3), tree(3)]);

    expect(peak).toBe(4);
  });
});
