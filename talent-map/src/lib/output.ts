import { constants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toCsv } from './csv.js';
import { UsageError } from './errors.js';
import { renderReport } from './report.js';
import type { TalentMap } from './talent-map.js';

const PEOPLE_COLUMNS = [
  'name',
  'title',
  'headline',
  'seniority',
  'department',
  'company',
  'company_domain',
  'joined_company',
  'years_at_company',
  'location',
  'linkedin_url',
] as const;

export function peopleCsv(map: TalentMap): string {
  const rows = map.shortlist.map((person) => [
    person.name,
    person.title,
    person.headline,
    person.seniority,
    person.department,
    person.company?.name,
    person.company?.domain,
    person.joinedCompany,
    person.tenureYears === undefined ? undefined : Number(person.tenureYears.toFixed(1)),
    person.location,
    person.linkedinUrl,
  ]);
  return toCsv(PEOPLE_COLUMNS, rows);
}

/** A sortable, filesystem-safe id such as `20261111-103105-data-engineer` (UTC). */
export function runId(map: TalentMap): string {
  const stamp = map.generatedAt.slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const slug = map.options.roles.join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${stamp}-${slug || 'role'}`;
}

/** Creates the output folder and checks it is writable, before any credits are spent. */
export async function prepareOutputDir(outDir: string): Promise<void> {
  try {
    await mkdir(outDir, { recursive: true });
    await access(outDir, constants.W_OK);
  } catch (error) {
    throw new UsageError(`Cannot write to --out "${outDir}": ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
}

/** Writes report.html, run.json and (when a shortlist was fetched) people.csv. Returns the folder and file names. */
export async function writeOutputs(map: TalentMap, outDir: string): Promise<{ dir: string; files: string[] }> {
  const dir = join(outDir, runId(map));
  await mkdir(dir, { recursive: true });
  const files: [string, string][] = [
    ['report.html', renderReport(map)],
    ['run.json', `${JSON.stringify(map, null, 2)}\n`],
  ];
  if (map.shortlist.length > 0) files.push(['people.csv', peopleCsv(map)]);
  await Promise.all(files.map(([name, content]) => writeFile(join(dir, name), content)));
  return { dir, files: files.map(([name]) => name) };
}
