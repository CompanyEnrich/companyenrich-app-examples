/**
 * Returns a wrapper that lets at most `max` wrapped calls run at once, across every caller
 * that shares it. Wrap the API calls themselves, not the code that waits on them, so nested
 * or recursive callers still share one cap.
 */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active < max) active += 1;
    // A finishing call hands its slot straight to us, so `active` never goes above `max`.
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
