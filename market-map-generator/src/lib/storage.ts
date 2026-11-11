import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Company } from '@companyenrich/sdk';
import { z } from 'zod';
import { UsageError } from './errors.ts';

/** The files every run writes into its output folder. */
export const OUTPUT_FILES = ['companies.json', 'map.html', 'map.svg', 'companies.csv'] as const;

/** What companies.json holds, so a later run can re-render the map with --from at no cost. */
export interface SavedCompanies {
  theme: string;
  query: string;
  fetchedOn: string;
  companies: Company[];
}

const text = z.string().nullish();
const named = z.object({ name: text }).nullish();

/** The company fields the app reads. Other fields are kept as they are. */
const SavedCompanySchema = z.looseObject({
  id: z.string(),
  domain: z.string(),
  website: z.string(),
  logoUrl: z.string(),
  name: text,
  description: text,
  industry: text,
  industries: z.array(z.string()).nullish(),
  categories: z.array(z.string()).nullish(),
  keywords: z.array(z.string()).nullish(),
  employees: text,
  foundedYear: z.number().nullish(),
  location: z.object({ country: named, state: named, city: named }).nullish(),
});

const SavedCompaniesSchema = z.object({
  theme: z.string(),
  query: z.string(),
  fetchedOn: z.string(),
  companies: z.array(SavedCompanySchema),
});

/** Reads a companies.json from an earlier run, checks its shape, and checks it was made for this theme. */
export async function loadSavedCompanies(path: string, themeSlug: string): Promise<SavedCompanies> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new UsageError(`Cannot read ${path} as JSON. Pass a companies.json written by an earlier run.`);
  }
  const result = SavedCompaniesSchema.safeParse(raw);
  if (!result.success) {
    const [issue] = result.error.issues;
    throw new UsageError(`${path} is not a companies.json written by this app (${issue?.path.join('.') || 'root'}: ${issue?.message}).`);
  }
  if (result.data.theme !== themeSlug) {
    throw new UsageError(`${path} was saved for theme "${result.data.theme}", not "${themeSlug}". Pass themes/${result.data.theme}.yaml or the matching file.`);
  }
  return result.data as SavedCompanies;
}

/**
 * Creates the output folder and checks that every file the run will write can be written there, so a
 * bad --out (or a folder named companies.json in the way) fails before any credits are spent.
 */
export async function prepareOutput(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
  } catch {
    throw new UsageError(`Cannot write to the output folder ${dir}. Pick another one with --out.`);
  }
  for (const name of OUTPUT_FILES) {
    const path = join(dir, name);
    const existing = await stat(path).catch(() => null);
    if (!existing) continue;
    if (!existing.isFile()) throw new UsageError(`${path} exists and is not a file. Move it or pick another folder with --out.`);
    await access(path, constants.W_OK).catch(() => {
      throw new UsageError(`${path} is not writable. Pick another folder with --out.`);
    });
  }
}

/** Writes to a temporary file next to the target, then renames it, so a failed write never leaves a half-written file. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Saves results that were paid for. If the output folder fails, falls back to the system temp folder,
 * and as a last resort prints the JSON, so paid data is never lost. Returns where it was saved.
 */
export async function savePaidResults(source: SavedCompanies, path: string, log: (line: string) => void): Promise<string | null> {
  const json = `${JSON.stringify(source, null, 2)}\n`;
  const fallback = join(tmpdir(), `market-map-${source.theme}-${Date.now()}.json`);
  for (const target of [path, fallback]) {
    try {
      await writeFileAtomic(target, json);
      if (target !== path) log(`Could not write ${path}; saved the paid results to ${target} instead.`);
      return target;
    } catch {
      // Try the next location.
    }
  }
  log(`Could not save the paid results to any file. Here they are, so nothing is lost:\n${json}`);
  return null;
}
