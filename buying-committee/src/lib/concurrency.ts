export const MAX_CONCURRENCY = 4;

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * One cap shared by every call made through it, however the callers are nested.
 * (Four workers that each run a `Promise.all` would not be a cap of four.)
 * Rate limits are handled by the SDK client (see client.ts), which retries 429s with backoff.
 */
export function createLimiter(max: number): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];

  return async (task) => {
    if (active < max) active++;
    // A finishing task hands its slot straight to the next waiter, so `active` never overshoots.
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** Run `task` for every item with at most `max` in flight, keeping input order. */
export function mapWithConcurrency<T, R>(items: readonly T[], max: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const limit = createLimiter(max);
  return Promise.all(items.map((item, index) => limit(() => task(item, index))));
}
