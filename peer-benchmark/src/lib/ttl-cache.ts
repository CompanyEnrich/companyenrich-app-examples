export type CacheSource = 'cache' | 'in-flight' | 'loaded';

/**
 * A small in-memory cache with expiry. `getOrLoad` also shares one in-flight
 * load between concurrent callers, so two requests for the same company in the
 * same second pay for one API call, not two.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  /** A rejected load is not cached, so the next call tries again. */
  async getOrLoad(key: string, load: () => Promise<T>): Promise<{ value: T; source: CacheSource }> {
    const cached = this.get(key);
    if (cached !== undefined) return { value: cached, source: 'cache' };

    const inFlight = this.pending.get(key);
    if (inFlight) return { value: await inFlight, source: 'in-flight' };

    const promise = load();
    this.pending.set(key, promise);
    try {
      const value = await promise;
      this.set(key, value);
      return { value, source: 'loaded' };
    } finally {
      this.pending.delete(key);
    }
  }
}
