/**
 * Maps `items` through `fn` with at most `limit` calls in flight, keeping input order.
 * After the first failure no new calls start, but calls already running are allowed to finish
 * (their side effects, such as cached counts, are kept) before the first error is rethrown.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  // An object rather than a `let`, so the compiler sees the workers' writes after they finish.
  const failure: { happened: boolean; error: unknown } = { happened: false, error: undefined };

  async function worker(): Promise<void> {
    while (!failure.happened && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        if (!failure.happened) {
          failure.happened = true;
          failure.error = error;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  if (failure.happened) throw failure.error;
  return results;
}
