export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Runs at most `concurrency` tasks at once, across every caller that shares
 * this limiter. The server keeps one for all CompanyEnrich calls, so two
 * benchmarks running together still make at most 4 calls at a time.
 */
export function createLimiter(concurrency: number): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < concurrency) active += 1;
    // A finishing task hands its slot straight to the next waiter, so a new
    // caller can never slip in between and push the count over the limit.
    else await new Promise<void>((resolve) => waiting.push(resolve));

    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}
