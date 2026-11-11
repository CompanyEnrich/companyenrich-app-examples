export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Returns a function that runs tasks with at most `limit` in flight. Share one limiter between
 * every caller that should count toward the same cap: nested fan-outs then still stay under it.
 */
export function createLimiter(limit: number): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];

  return async (task) => {
    if (active < limit) active += 1;
    // A finishing task hands its slot straight to the next waiter, so no newcomer can jump in between.
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

/** Runs `fn` over `items` with at most `limit` calls in flight, returning results in input order. */
export function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const run = createLimiter(limit);
  return Promise.all(items.map((item, index) => run(() => fn(item, index))));
}
