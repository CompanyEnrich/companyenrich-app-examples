import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChampionRow } from '../src/lib/csv.js';
import { describeError } from '../src/lib/errors.js';
import { runInit } from '../src/lib/init.js';
import { type TrackerState, loadState, saveState } from '../src/lib/state.js';
import { type Handler, fakeApi, json, notFound } from './helpers/fake-api.js';
import { person, role } from './helpers/fixtures.js';

const jane = person([role('acme.example'), role('community.example', { position: 'Member', seniority: null, start: '2020-01-01' })], { id: 101 });
const omar = person([role('initech.example', { position: 'VP Revenue', seniority: 'vp', start: '2024-02-01' })], { id: 202, name: 'Omar Example' });

const routes: Record<string, Handler> = {
  'POST /v2/people/enrich': ({ body }) => (body.email === 'jane@acme.example' ? jane : notFound()),
  'GET /v2/people/:id': ({ params }) => (params[0] === '202' ? omar : notFound()),
};

const janeRow: ChampionRow = { line: 2, email: 'jane@acme.example', accountDomain: 'acme.example', dealName: 'Acme rollout', owner: 'alex@yourco.example' };
const omarRow: ChampionRow = { line: 3, personId: '202', accountDomain: 'initech.example', dealName: 'Initech pilot', owner: 'sam@yourco.example' };
const missingRow: ChampionRow = { line: 4, email: 'nobody@acme.example', accountDomain: 'acme.example', dealName: 'Acme rollout', owner: 'alex@yourco.example' };

let statePath: string;
let lines: string[];
const log = (line: string) => lines.push(line);
const NOW = new Date('2026-11-11T08:00:00Z');

beforeEach(() => {
  statePath = join(mkdtempSync(join(tmpdir(), 'champion-tracker-')), 'state', 'state.json');
  lines = [];
});

describe('runInit', () => {
  it('resolves emails and person ids into minimal baselines, reporting not-found rows at 0 credits', async () => {
    const api = fakeApi(routes);
    const summary = await runInit({ csvPath: 'champions.csv', client: api.client, rows: [janeRow, omarRow, missingRow], statePath, maxCredits: 100, dryRun: false, now: NOW, log });

    expect(summary).toMatchObject({ tracked: 2, added: 2, notFound: 1, spent: 7 });
    expect(lines.join('\n')).toMatch(/line 4: no person found for nobody@acme.example \(0 credits\)/);

    const state = loadState(statePath)!;
    expect(state.champions.map((champion) => champion.personId)).toEqual(['101', '202']);
    expect(state.champions[0]).toEqual({
      key: expect.stringMatching(/^email:[0-9a-f]{64}$/),
      personId: '101',
      accountDomain: 'acme.example',
      dealName: 'Acme rollout',
      owner: 'alex@yourco.example',
      lastCheckedAt: NOW.toISOString(),
      baseline: {
        status: 'active',
        companyId: 'co-acme.example',
        companyDomain: 'acme.example',
        companyName: 'Acme',
        position: 'Director of Sales',
        seniority: 'director',
        positionStartDate: '2023-04-01',
        otherCurrentCompanies: ['co-community.example'],
      },
    });
    // No names, emails or profile links are stored.
    const raw = readFileSync(statePath, 'utf8');
    expect(raw).not.toMatch(/Jane|Omar|linkedin|@acme\.example/);
  });

  it('flags a champion who is no longer at the account so the first check reports the move', async () => {
    const api = fakeApi(routes);
    await runInit({ csvPath: 'champions.csv', client: api.client, rows: [{ ...omarRow, accountDomain: 'acme.example' }], statePath, maxCredits: 100, dryRun: false, now: NOW, log });

    const [record] = loadState(statePath)!.champions;
    expect(record!.baseline).toMatchObject({ companyId: null, companyDomain: 'acme.example', position: null, otherCurrentCompanies: [] });
    expect(lines.join('\n')).toMatch(/Omar Example is not listed at acme\.example right now \(current: VP Revenue at Initech\)/);
  });

  it('re-uses tracked champions for free, updates their deal details and drops removed rows', async () => {
    const first = fakeApi(routes);
    await runInit({ csvPath: 'champions.csv', client: first.client, rows: [janeRow, omarRow], statePath, maxCredits: 100, dryRun: false, now: NOW, log });

    const second = fakeApi(routes);
    const summary = await runInit({ csvPath: 'champions.csv', client: second.client, rows: [{ ...janeRow, owner: 'jo@yourco.example' }], statePath, maxCredits: 100, dryRun: false, now: NOW, log });

    expect(second.calls.filter((call) => call.path !== '/v2/me')).toHaveLength(0);
    expect(summary).toMatchObject({ tracked: 1, kept: 1, removed: 1, spent: 0 });
    expect(loadState(statePath)!.champions.map((champion) => champion.owner)).toEqual(['jo@yourco.example']);
  });

  it('defers rows that do not fit under the cap', async () => {
    const api = fakeApi(routes);
    const summary = await runInit({ csvPath: 'champions.csv', client: api.client, rows: [janeRow, omarRow], statePath, maxCredits: 6, dryRun: false, now: NOW, log });

    expect(summary).toMatchObject({ added: 1, deferred: 1, spent: 5 });
    expect(api.callsTo('GET', '/v2/people/')).toHaveLength(0);
    expect(lines.join('\n')).toContain(`1 rows were not resolved. To resolve them, run "npm start -- init 'champions.csv' --max-credits 2 --state '${statePath}'".`);
  });

  it('skips a second row for a person who is already tracked', async () => {
    const api = fakeApi({ ...routes, 'GET /v2/people/:id': () => jane });
    const summary = await runInit({ csvPath: 'champions.csv', client: api.client, rows: [janeRow, { ...omarRow, personId: '101' }], statePath, maxCredits: 100, dryRun: false, now: NOW, log });

    expect(summary.tracked).toBe(1);
    expect(lines.join('\n')).toMatch(/already tracked from another row/);
  });

  it('dry run makes no paid calls and writes nothing', async () => {
    const api = fakeApi(routes);
    const summary = await runInit({ csvPath: 'champions.csv', client: api.client, rows: [janeRow, omarRow], statePath, maxCredits: 100, dryRun: true, now: NOW, log });

    expect(api.calls.map((call) => call.path)).toEqual(['/v2/me']);
    expect(existsSync(statePath)).toBe(false);
    expect(summary.spent).toBe(0);
    expect(lines.join('\n')).toMatch(/Up to 7 credits/);
  });

  it('rejects an invalid key with a one-line message before any paid call', async () => {
    const api = fakeApi({ 'GET /v2/me': () => json(401, { title: 'Unauthorized', status: 401 }) });
    const error = await runInit({ csvPath: 'champions.csv', client: api.client, rows: [janeRow], statePath, maxCredits: 100, dryRun: false, now: NOW, log }).catch((caught) => caught);

    expect(describeError(error)).toBe('CompanyEnrich rejected the API key (401). Check COMPANYENRICH_API_KEY; keys are at https://companyenrich.com/dashboard');
    expect(api.calls).toHaveLength(1);
    expect(existsSync(statePath)).toBe(false);
  });

  it('stops when credits run out and keeps what was already resolved', async () => {
    const existing: TrackerState = { version: 1, champions: [] };
    saveState(statePath, existing);
    const api = fakeApi({ ...routes, 'GET /v2/people/:id': () => json(402, { title: 'Payment Required', status: 402 }) });
    const summary = await runInit({ csvPath: 'champions.csv', client: api.client, rows: [janeRow, omarRow, { ...omarRow, line: 5, personId: '303' }], statePath, maxCredits: 100, dryRun: false, now: NOW, log });

    expect(summary).toMatchObject({ added: 1, deferred: 2, spent: 5, stoppedBy: expect.stringMatching(/out of credits/) });
    expect(api.callsTo('GET', '/v2/people/')).toHaveLength(1);
    expect(loadState(statePath)!.champions).toHaveLength(1);
  });
});
