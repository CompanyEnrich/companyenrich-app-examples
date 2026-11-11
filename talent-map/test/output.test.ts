import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toCsv } from '../src/lib/csv.js';
import { UsageError } from '../src/lib/errors.js';
import { peopleCsv, prepareOutputDir, runId, writeOutputs } from '../src/lib/output.js';
import { buildTalentMap } from '../src/lib/talent-map.js';
import { fakeApi } from './fake-api.js';

const NOW = new Date('2026-11-11T09:30:00Z');

function talentMap(dryRun: boolean) {
  return buildTalentMap(
    {
      roles: ['data engineer', 'Analytics Engineer'],
      seniority: [],
      environment: { technologies: [], employees: [] },
      people: 3,
      trendTop: 1,
      maxCredits: 50,
      dryRun,
    },
    { client: fakeApi().client, log: () => {}, now: NOW },
  );
}

describe('toCsv', () => {
  it('quotes fields with commas, quotes or newlines', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'say "hi"'], ['line\nbreak', 3]])).toBe('a,b\n"x,y","say ""hi"""\n"line\nbreak",3\n');
  });

  it('neutralises cells that a spreadsheet would run as a formula', () => {
    expect(toCsv(['title'], [['=HYPERLINK("http://x")'], ['+1 555'], ['@sum'], ['-2']])).toBe(
      'title\n"\'=HYPERLINK(""http://x"")"\n\'+1 555\n\'@sum\n\'-2\n',
    );
    expect(toCsv(['n'], [[-2]])).toBe('n\n-2\n'); // real numbers are left alone
  });
});

describe('outputs', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('refuses an output folder it cannot create, before anything is spent', async () => {
    dir = await mkdtemp(join(tmpdir(), 'talent-map-'));
    const file = join(dir, 'not-a-folder');
    await writeFile(file, '');
    await expect(prepareOutputDir(join(file, 'reports'))).rejects.toThrow(UsageError);
    await expect(prepareOutputDir(join(dir, 'reports'))).resolves.toBeUndefined();
  });

  it('names the run folder by time and role', async () => {
    expect(runId(await talentMap(true))).toBe('20261111-093000-data-engineer-analytics-engineer');
  });

  it('writes one CSV row per shortlisted person', async () => {
    const lines = peopleCsv(await talentMap(false)).trim().split('\n');
    expect(lines[0]).toBe('name,title,headline,seniority,department,company,company_domain,joined_company,years_at_company,location,linkedin_url');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(
      'Candidate 1,Senior Data Engineer,Senior Data Engineer | Spark | Snowflake,senior,engineering-technical/data-science,Alpha Payments,alpha.example,2021-03-01,5.7,"Austin, Texas, United States",https://www.linkedin.com/in/candidate-1',
    );
  });

  it('writes report.html, run.json and people.csv, and skips the CSV on a dry run', async () => {
    dir = await mkdtemp(join(tmpdir(), 'talent-map-'));
    const full = await writeOutputs(await talentMap(false), dir);
    expect((await readdir(full.dir)).sort()).toEqual(['people.csv', 'report.html', 'run.json']);
    const record = JSON.parse(await readFile(join(full.dir, 'run.json'), 'utf8'));
    expect(record.status).toBe('complete');

    const dry = await writeOutputs(await talentMap(true), join(dir, 'dry'));
    expect(dry.files).toEqual(['report.html', 'run.json']);
  });
});
