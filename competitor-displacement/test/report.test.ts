import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatAmount, formatRoundType, latestRound } from '../src/lib/funding.js';
import { runPipeline, type RunRecord } from '../src/lib/pipeline.js';
import { accountsCsv, renderReport } from '../src/lib/report.js';
import { fakeApi, NOW } from './fake-api.js';

let outDir: string;
let full: RunRecord;
let dry: RunRecord;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'competitor-displacement-report-'));
  const base = {
    competitor: 'zendesk',
    mine: 'intercom',
    countries: [],
    employees: [],
    categories: [],
    accounts: 5,
    contacts: 1,
    withFunding: true,
    maxCredits: 40,
    exclude: [],
    outDir,
  };
  const context = { client: fakeApi().client, log: () => undefined, now: () => NOW };
  full = await runPipeline({ ...base, dryRun: false }, context);
  dry = await runPipeline({ ...base, dryRun: true }, { ...context, client: fakeApi().client });
});
afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe('renderReport', () => {
  it('shows market size, both breakdowns and the tiers', () => {
    const report = renderReport(full);
    expect(report).toContain('# Displacement report: zendesk, not intercom');
    expect(report).toContain('| Run zendesk and intercom | 1 |');
    expect(report).toContain('| **Targets: zendesk, not intercom** | **7** |');
    expect(report).toContain('| US | 5 | 71.4% |');
    expect(report).toContain('| 201-500 | 1 | 14.3% |');
    expect(report).toMatch(/\| 1 \| Growing and recently funded: .* \| 2 \| 28\.6% \|/);
  });

  it('lists ranked accounts with their why-now signals and latest round', () => {
    const report = renderReport(full);
    expect(report).toContain(
      '| 1 | 1 | Alpha | alpha.example | US | 51-200 | Software | headcount +10% or more in 6 months; latest round in 2025 or later, $1M+ raised | Series B, $20M, 2025-09-15 |',
    );
    expect(report).toContain('| 5 | 3 | Echo | echo.example | US | 51-200 | Software | - | Series B, $20M, 2025-09-15 |');
  });

  it('shows the persona, its fallback, the contacts and where nobody matched', () => {
    const report = renderReport(full);
    expect(report).toContain('**Customer service and support** (`customer-service`)');
    expect(report).toContain('| Bravo | 1 | Person 3 | VP Operations | vp | fallback |');
    expect(report).toContain('No one matched the persona or its fallback at delta.example, echo.example');
  });

  it('itemises the credits charged', () => {
    const report = renderReport(full);
    expect(report).toContain('| accounts | tier 1: 2 of 2 companies | 4 | 4 |');
    expect(report).toContain('Charged by this run: **16** credits (cap 40).');
  });

  it('marks a dry run and shows the estimate instead of a bill', () => {
    const report = renderReport(dry);
    expect(report).toContain('> Dry run: market size and tiers are real');
    expect(report).toContain('| accounts | 5 companies x 2 (tier 1: 2, tier 2: 2, tier 3: 1) | 10 |');
    expect(report).not.toContain('## Contacts');
  });
});

describe('CSV and funding helpers', () => {
  it('quotes CSV fields with commas or quotes', () => {
    const csv = accountsCsv([{ ...full.accounts[0]!, company: { ...full.accounts[0]!.company, name: 'Alpha, "Inc"' } }]);
    expect(csv.split('\n')[1]).toContain('"Alpha, ""Inc"""');
  });

  it('formats the latest round from the financial expansion', () => {
    expect(formatRoundType('series_b')).toBe('Series B');
    expect(formatRoundType('debt_financing')).toBe('Debt financing');
    expect(formatRoundType('Corporate Round')).toBe('Corporate Round');
    expect(formatAmount('60000000 USD')).toBe('$60M');
    expect(formatAmount('2500000 EUR')).toBe('2.5M EUR');
    expect(formatAmount('undisclosed')).toBe('undisclosed');
    expect(latestRound({ fundingStage: 'seed', fundingDate: '2025-03-01T00:00:00Z' })).toBe('Seed, 2025-03-01');
    expect(latestRound({})).toBeUndefined();
    expect(latestRound(undefined)).toBeUndefined();
  });
});
