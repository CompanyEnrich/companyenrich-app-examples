/**
 * A small in-memory cache with a size limit (least recently used entries are
 * evicted first) and a time-to-live. A Map keeps insertion order, so moving an
 * entry to the end on every read makes the first key the least recently used.
 *
 * It lives in one server process. On serverless platforms each instance has its
 * own copy; swap in Redis or a KV store if you need a shared cache.
 */
export class LruCache<V> {
  readonly #entries = new Map<string, { value: V; expiresAt: number }>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: { maxEntries: number; ttlMs: number; now?: () => number }) {
    this.#maxEntries = options.maxEntries;
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
  }

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    if (entry.expiresAt <= this.#now()) return undefined;
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
    if (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  get size(): number {
    return this.#entries.size;
  }
}
