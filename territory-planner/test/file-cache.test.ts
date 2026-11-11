import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileCache, ONE_DAY_MS, stableKey } from '../src/lib/file-cache.js';

async function tempFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'territory-cache-')), '.cache', 'counts.json');
}

describe('stableKey', () => {
  it('ignores object key order, including nested objects', () => {
    expect(stableKey({ country: 'US', state: 1, employees: { in: ['51-200'] } }))
      .toBe(stableKey({ employees: { in: ['51-200'] }, state: 1, country: 'US' }));
    expect(stableKey({ state: 1 })).not.toBe(stableKey({ state: 2 }));
  });
});

describe('FileCache', () => {
  it('saves counts and reads them back in a later run', async () => {
    const file = await tempFile();
    const first = await FileCache.open<number>(file);
    first.set('a', 42);
    await first.save();

    const second = await FileCache.open<number>(file);
    expect(second.get('a')).toBe(42);
    expect(second.get('missing')).toBeUndefined();
  });

  it('expires entries after a day', async () => {
    const file = await tempFile();
    let now = 1_000_000;
    const cache = await FileCache.open<number>(file, { now: () => now });
    cache.set('a', 1);
    await cache.save();

    now += ONE_DAY_MS - 1;
    expect((await FileCache.open<number>(file, { now: () => now })).get('a')).toBe(1);
    now += 2;
    expect((await FileCache.open<number>(file, { now: () => now })).get('a')).toBeUndefined();
  });

  it('ignores existing entries with refresh but still saves new ones', async () => {
    const file = await tempFile();
    const cache = await FileCache.open<number>(file);
    cache.set('a', 1);
    await cache.save();

    const refreshed = await FileCache.open<number>(file, { refresh: true });
    expect(refreshed.get('a')).toBeUndefined();
    refreshed.set('a', 2);
    await refreshed.save();
    expect((await FileCache.open<number>(file)).get('a')).toBe(2);
  });

  it('starts empty when the file is damaged, and repairs it on save', async () => {
    const file = await tempFile();
    const seed = await FileCache.open<number>(file);
    seed.set('x', 1);
    await seed.save();
    await writeFile(file, '{not json');

    const cache = await FileCache.open<number>(file);
    expect(cache.size).toBe(0);
    cache.set('b', 3);
    await cache.save();
    expect(JSON.parse(await readFile(file, 'utf8')).entries.b.value).toBe(3);
  });
});
