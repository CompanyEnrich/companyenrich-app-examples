import { constants } from 'node:fs';
import { access, appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { UsageError } from './errors.ts';

/** Checks that `path` can be written, so a bad `--out` fails before any credits are spent. */
export async function assertWritableFile(path: string): Promise<void> {
  try {
    if ((await stat(path).catch(() => null))?.isDirectory()) throw new Error('it is a directory');
    await mkdir(dirname(path), { recursive: true });
    await access(dirname(path), constants.W_OK);
  } catch (error) {
    throw new UsageError(`Cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        throw new Error(`${path}:${index + 1} is not valid JSON`);
      }
    });
}

export async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((row) => JSON.stringify(row) + '\n').join(''));
}

/**
 * Appends rows as they finish, so a long paid run keeps everything done before a crash.
 * Writes are chained so concurrent callers never interleave.
 */
export async function createJsonlWriter(path: string): Promise<(row: unknown) => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '');
  let queue = Promise.resolve();
  return (row) => {
    queue = queue.then(() => appendFile(path, JSON.stringify(row) + '\n'));
    return queue;
  };
}
