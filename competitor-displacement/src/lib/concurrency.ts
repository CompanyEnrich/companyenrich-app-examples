/** Fan-out calls stay at 4 in flight. The SDK retries 429 responses with backoff on top of this. */
export const MAX_CONCURRENCY = 4;

/**
 * Maps over items with at most `limit` calls in flight, keeping results in input order.
 * On the first failure it starts no new calls, waits for the calls already in flight to settle
 * (so paid calls that succeeded are recorded by their callbacks), then rethrows that failure.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let failure: { error: unknown } | undefined;
  let next = 0;
  const worker = async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
  return results;
}
