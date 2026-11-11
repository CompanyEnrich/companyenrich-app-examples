import { modifiedAt, readJsonFile, writeJsonFile } from './json-file';

// A small TTL cache. With `file` set it persists to JSON, so the web app and
// the batch CLI share one cache and a restart does not re-bill recent lookups.
// It reloads the file whenever another process has changed it.

export interface CacheEntry<T> {
  /** The key the value was stored under, checked on read so a hand-edited or mixed-up file never serves the wrong entry. */
  key: string;
  value: T;
  storedAt: number;
}

export interface CacheOptions {
  ttlMs: number;
  file?: string;
  maxEntries?: number;
  now?: () => number;
}

export class TtlCache<T> {
  private entries = new Map<string, CacheEntry<T>>();
  private loadedAt = -1;
  private readonly ttlMs: number;
  private readonly file: string | undefined;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: CacheOptions) {
    this.ttlMs = options.ttlMs;
    this.file = options.file;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  get(key: string): CacheEntry<T> | undefined {
    this.syncFromDisk();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.key !== key || this.now() - entry.storedAt >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, value: T): void {
    this.syncFromDisk();
    this.entries.delete(key);
    this.entries.set(key, { key, value, storedAt: this.now() });
    this.prune();
    if (this.file) {
      writeJsonFile(this.file, Object.fromEntries(this.entries));
      this.loadedAt = modifiedAt(this.file);
    }
  }

  private syncFromDisk(): void {
    if (!this.file) return;
    const mtime = modifiedAt(this.file);
    if (mtime === this.loadedAt) return;
    const stored = readJsonFile<Record<string, CacheEntry<T>>>(this.file) ?? {};
    this.entries = new Map(Object.entries(stored));
    this.loadedAt = mtime;
  }

  /** Drops expired entries, then the oldest ones beyond `maxEntries`. */
  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.storedAt >= this.ttlMs) this.entries.delete(key);
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(key);
    }
  }
}
