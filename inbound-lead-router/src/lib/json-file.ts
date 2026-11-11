import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Tiny JSON persistence for local state. Writes go to a temp file first and are
// renamed into place, so a crash never leaves a half-written file behind.

/** Parsed contents, or undefined when the file does not exist yet. */
export function readJsonFile<T>(file: string): T | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${file} is not valid JSON. Fix it or delete it to start fresh.`);
  }
}

export function writeJsonFile(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temp, file);
}

/** Last modification time in ms, or -1 when the file does not exist. */
export function modifiedAt(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}
