import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  savedAt: number;
}

interface CacheFile<T> {
  version: 1;
  entries: Record<string, CacheEntry<T>>;
}

/** JSON.stringify with sorted object keys, so equal filters always produce the same cache key. */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return inner;
    return Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)));
  });
}

export interface FileCacheOptions {
  /** How long entries stay valid. Defaults to one day. */
  ttlMs?: number;
  /** Ignore existing entries (new ones are still saved). */
  refresh?: boolean;
  now?: () => number;
}

/**
 * A small JSON file cache keyed by query. The planner keeps two: free counts for a day, so
 * re-running with other territory settings does not repeat hundreds of requests, and paid sample
 * results, so a run that stopped partway never pays twice for a territory it already fetched.
 */
export class FileCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private dirty = false;

  private constructor(
    private readonly file: string | null,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  /** A cache that never reads or writes a file, for tests. */
  static inMemory<T>({ ttlMs = ONE_DAY_MS, now = Date.now }: FileCacheOptions = {}): FileCache<T> {
    return new FileCache<T>(null, ttlMs, now);
  }

  /** Opens the cache file, dropping expired entries. A missing or unreadable file starts empty. */
  static async open<T>(file: string, { ttlMs = ONE_DAY_MS, refresh = false, now = Date.now }: FileCacheOptions = {}): Promise<FileCache<T>> {
    const cache = new FileCache<T>(file, ttlMs, now);
    if (refresh) return cache;
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as CacheFile<T>;
      if (parsed.version === 1) {
        for (const [key, entry] of Object.entries(parsed.entries)) {
          if (cache.isFresh(entry)) cache.entries.set(key, entry);
        }
      }
    } catch {
      // No cache yet, or a damaged one: start empty and overwrite it on save.
    }
    return cache;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    return entry && this.isFresh(entry) ? entry.value : undefined;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, savedAt: this.now() });
    this.dirty = true;
  }

  /** Writes the cache atomically (temp file, then rename) if anything changed. */
  async save(): Promise<void> {
    if (!this.file || !this.dirty) return;
    const fresh = [...this.entries].filter(([, entry]) => this.isFresh(entry));
    const body: CacheFile<T> = { version: 1, entries: Object.fromEntries(fresh) };
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(body));
    await rename(temp, this.file);
    this.dirty = false;
  }

  private isFresh(entry: CacheEntry<T>): boolean {
    return this.now() - entry.savedAt < this.ttlMs;
  }
}
