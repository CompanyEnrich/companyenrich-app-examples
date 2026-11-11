/**
 * Caps how many tasks run at once across the whole process. Every CompanyEnrich
 * call goes through one shared instance, so concurrent webhook requests, the
 * playground and batch chunks together never exceed the limit.
 */
export class Limiter {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/**
 * Single-flight: concurrent callers with the same key share one in-progress promise,
 * so six simultaneous signups from one company trigger one paid lookup, not six.
 */
export class SingleFlight<T> {
  private inflight = new Map<string, Promise<T>>();

  /** The shared promise for `key`, if a call is already running. */
  pending(key: string): Promise<T> | undefined {
    return this.inflight.get(key);
  }

  /** Starts `task` as the call for `key`. Call only after `pending(key)` returned undefined, with no await in between. */
  start(key: string, task: () => Promise<T>): Promise<T> {
    const promise = task().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
}
