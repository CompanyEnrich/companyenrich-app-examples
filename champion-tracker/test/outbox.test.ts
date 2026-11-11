import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { type CheckOptions, runCheck } from '../src/lib/check.js';
import { parseConfig } from '../src/lib/config.js';
import { type ChampionRecord, loadState, saveState } from '../src/lib/state.js';
import { fakeApi, notFound } from './helpers/fake-api.js';
import { baseline, person, role } from './helpers/fixtures.js';

const config = parseConfig({ icp: { country: { weight: 1, match: ['US'] } }, buyerPersona: { seniority: ['vp'] } });
const NOW = new Date('2026-11-11T08:00:00Z');
const LATER = new Date('2026-11-11T09:00:00Z');

const promoted = person([role('acme.example', { position: 'VP Sales', seniority: 'vp', start: '2026-09-01' })], { id: 1, name: 'Jane Champion' });
const champion: ChampionRecord = {
  key: 'id:1',
  personId: '1',
  accountDomain: 'acme.example',
  dealName: 'Acme rollout',
  owner: 'alex@yourco.example',
  baseline: baseline(),
  lastCheckedAt: '2026-10-01T08:00:00.000Z',
};

let dir: string;
let statePath: string;
let outputDir: string;
let lines: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'champion-tracker-'));
  statePath = join(dir, 'state.json');
  outputDir = join(dir, 'output');
  lines = [];
  saveState(statePath, { version: 1, champions: [structuredClone(champion)] });
});

function options(overrides: Partial<CheckOptions>): CheckOptions {
  return {
    client: fakeApi({ 'GET /v2/people/:id': ({ params }) => (params[0] === '1' ? promoted : notFound()) }).client,
    config,
    statePath,
    outputDir,
    maxCredits: 40,
    checkEveryDays: 30,
    pendingOnly: false,
    withContacts: false,
    dryRun: false,
    now: NOW,
    log: (line) => lines.push(line),
    ...overrides,
  };
}

describe('digest outbox', () => {
  it('keeps an alert whose digest could not be written and delivers it on the next run', async () => {
    const blocked = join(dir, 'not-a-folder');
    writeFileSync(blocked, 'a file where the output folder should be');
    const failed = await runCheck(options({ outputDir: blocked }));

    expect(failed.deliveryErrors[0]).toMatch(/Could not write .*digest-2026-11-11\.md/);
    const saved = loadState(statePath)!;
    expect(saved.champions[0]!.baseline.position).toBe('VP Sales'); // the baseline advanced...
    expect(saved.outbox).toHaveLength(1); // ...and the alert was kept with it
    expect(saved.outbox![0]!.report.alerts[0]!.change.kind).toBe('promoted');

    // Nobody is due any more, but the waiting digest still goes out.
    const retried = await runCheck(options({ now: LATER }));
    expect(retried).toMatchObject({ report: null, redelivered: 1, deliveryErrors: [] });
    expect(readFileSync(join(outputDir, 'digest-2026-11-11.md'), 'utf8')).toContain('### Promoted: Jane Champion is now VP Sales at Acme');
    expect(loadState(statePath)!.outbox).toEqual([]);
  });

  it('retries only the Slack post when the file was already written', async () => {
    let attempts = 0;
    const slack: typeof fetch = async () => (++attempts === 1 ? new Response('rate_limited', { status: 429 }) : new Response('ok'));
    const failed = await runCheck(options({ slackWebhookUrl: 'https://hooks.slack.example/T/B/X', fetch: slack }));

    expect(failed.deliveryErrors).toEqual(['Slack post failed: Slack returned 429: rate_limited']);
    expect(existsSync(join(outputDir, 'digest-2026-11-11.md'))).toBe(true);
    expect(loadState(statePath)!.outbox![0]!.undelivered).toEqual(['slack']);

    const retried = await runCheck(options({ slackWebhookUrl: 'https://hooks.slack.example/T/B/X', fetch: slack, now: LATER }));
    expect(retried).toMatchObject({ redelivered: 1, deliveryErrors: [] });
    expect(attempts).toBe(2);
    expect(loadState(statePath)!.outbox).toEqual([]);
  });

  it('removes delivered digests from state, since they name people', async () => {
    const result = await runCheck(options({}));
    expect(result.deliveryErrors).toEqual([]);
    expect(loadState(statePath)!.outbox).toEqual([]);
    expect(readFileSync(statePath, 'utf8')).not.toContain('Jane Champion');
  });

  it('gives a second run on the same day its own file', async () => {
    await runCheck(options({}));
    const second = await runCheck(options({ checkEveryDays: 0, now: LATER }));
    expect(second.digestPath).toBe(join(outputDir, 'digest-2026-11-11-2.md'));
    expect(existsSync(join(outputDir, 'digest-2026-11-11.md'))).toBe(true);
  });

  it('only reports waiting digests in a dry run', async () => {
    const blocked = join(dir, 'not-a-folder');
    writeFileSync(blocked, '');
    await runCheck(options({ outputDir: blocked }));
    const before = readFileSync(statePath, 'utf8');

    await runCheck(options({ dryRun: true, now: LATER }));
    expect(lines.join('\n')).toContain('1 earlier digests are waiting to be delivered; the next real run retries them.');
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    expect(existsSync(outputDir)).toBe(false);
  });
});
