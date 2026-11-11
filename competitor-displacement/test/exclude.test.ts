import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapLimit } from '../src/lib/concurrency.js';
import { UsageError } from '../src/lib/errors.js';
import { normalizeDomain, parseDomainList } from '../src/lib/exclude.js';
import { parseCliArgs } from '../src/lib/options.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'competitor-displacement-exclude-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('--exclude parsing', () => {
  it('reads one domain per line, skipping blanks and comments, normalised and de-duplicated', () => {
    expect(parseDomainList('# bought in March\nhttps://www.Alpha.example/pricing\n\nbravo.example\nalpha.example\n', 'list.txt')).toEqual([
      'alpha.example',
      'bravo.example',
    ]);
  });

  it("reads the domain column of a previous run's accounts.csv, including quoted fields with commas", () => {
    const csv = [
      'rank,tier,why_now,name,domain,country',
      '1,1,"headcount +10% or more in 6 months; latest round in 2025 or later, $1M+ raised","Alpha, Inc",alpha.example,US',
      '2,3,,Bravo,bravo.example,GB',
    ].join('\n');
    expect(parseDomainList(csv, 'accounts.csv')).toEqual(['alpha.example', 'bravo.example']);
  });

  it('points at the line that is not a domain', () => {
    expect(() => parseDomainList('alpha.example\nnot a domain\n', 'list.txt')).toThrow('list.txt line 2: "not a domain" is not a domain.');
  });

  it('strips scheme, www and path', () => {
    expect(normalizeDomain(' HTTP://www.Example.com/a?b ')).toBe('example.com');
  });

  it('is read and validated by the CLI parser, before any API call', async () => {
    const file = join(dir, 'accounts.csv');
    await writeFile(file, 'rank,domain\n1,alpha.example\n');
    expect(parseCliArgs(['--competitor', 'zendesk', '--exclude', file])?.exclude).toEqual(['alpha.example']);
    expect(() => parseCliArgs(['--competitor', 'zendesk', '--exclude', join(dir, 'missing.csv')])).toThrow(UsageError);
    await writeFile(join(dir, 'empty.txt'), '# nothing yet\n');
    expect(() => parseCliArgs(['--competitor', 'zendesk', '--exclude', join(dir, 'empty.txt')])).toThrow('has no domains');
  });
});

describe('mapLimit', () => {
  it('starts nothing new after a failure, lets in-flight calls finish, then rethrows', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const items = Array.from({ length: 10 }, (_, i) => i);
    const error = await mapLimit(items, 3, async (item) => {
      started.push(item);
      if (item === 0) throw new Error('boom');
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished.push(item);
      return item;
    }).catch((e: unknown) => e);

    expect((error as Error).message).toBe('boom');
    expect(started).toEqual([0, 1, 2]);
    expect(finished.sort()).toEqual([1, 2]);
  });

  it('keeps results in input order', async () => {
    await expect(mapLimit([30, 10, 20], 2, async (ms) => new Promise<number>((resolve) => setTimeout(() => resolve(ms), ms)))).resolves.toEqual([30, 10, 20]);
  });
});
