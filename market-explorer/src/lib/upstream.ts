/**
 * One limiter for every request this server makes to CompanyEnrich. It wraps the
 * SDK's `fetch`, so every route, every grid cell and every SDK retry shares the
 * same cap: at most `concurrency` requests in flight, at most `maxQueue` waiting,
 * and anything beyond that is refused at once instead of piling up.
 */
import { CompanyEnrichError } from '@companyenrich/sdk';

/** Extends the SDK's base error so the SDK passes it through unchanged. */
export class UpstreamBusyError extends CompanyEnrichError {
  override name = 'UpstreamBusyError';
}

export class UpstreamLimiter {
  private active = 0;
  private readonly queue: { start: () => void; cancel: (reason: unknown) => void }[] = [];

  constructor(
    readonly concurrency = 4,
    readonly maxQueue = 100,
  ) {}

  get inFlight(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.start();
    }
  }

  private acquire(signal?: AbortSignal | null): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new UpstreamBusyError('The server is busy with other CompanyEnrich requests.'));
    }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        start: () => {
          signal?.removeEventListener('abort', onAbort);
          this.active++;
          resolve();
        },
        cancel: reject,
      };
      // A request that times out or is cancelled while queued leaves the queue.
      const onAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index !== -1) this.queue.splice(index, 1);
        entry.cancel(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
  }
}

/** A `fetch` for the SDK that waits for a slot in `limiter` before each request. */
export function limitedFetch(limiter: UpstreamLimiter, fetchImpl: typeof fetch = fetch): typeof fetch {
  return (input, init) => limiter.run(() => fetchImpl(input, init), init?.signal);
}
