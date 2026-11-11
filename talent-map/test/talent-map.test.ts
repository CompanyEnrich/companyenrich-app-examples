import { describe, expect, it } from 'vitest';
import { BudgetExceededError } from '../src/lib/credits.js';
import { UsageError } from '../src/lib/errors.js';
import { renderReport } from '../src/lib/report.js';
import { buildTalentMap, RunStoppedError, type TalentMapOptions } from '../src/lib/talent-map.js';
import { defaultPeopleCount, fakeApi, PEOPLE } from './fake-api.js';

const NOW = new Date('2026-11-11T09:30:00Z');

const OPTIONS: TalentMapOptions = {
  roles: ['data engineer'],
  seniority: ['senior', 'director'],
  environment: { description: 'fintech companies', technologies: ['snowflake'], employees: ['201-500'], country: 'US' },
  minTenureYears: 2,
  people: 5,
  trendTop: 2,
  maxCredits: 50,
  dryRun: false,
};

function run(options: Partial<TalentMapOptions> = {}, api = fakeApi()) {
  const lines: string[] = [];
  const promise = buildTalentMap({ ...OPTIONS, ...options }, { client: api.client, log: (line) => lines.push(line), now: NOW });
  return { api, lines, promise };
}

describe('buildTalentMap', () => {
  it('sizes the pool with free counts, then shortlists, ranks companies and fetches trends', async () => {
    const { api, promise } = run();
    const map = await promise;

    const [search] = api.callsTo('/v2/people/search');
    expect(search?.body).toEqual({
      filter: {
        position: ['data engineer'],
        department: ['engineering-technical/data-science'],
        seniority: ['senior', 'director'],
        currentCompanyStartDate: { before: '2024-11-11' },
      },
      company: {
        semantic: { query: 'fintech companies' },
        filter: { technologies: { all: ['snowflake'] }, employees: ['201-500'], country: 'US' },
      },
      pageSize: 5,
    });

    expect(map.status).toBe('complete');
    expect(map.sizing).toMatchObject({ withTitle: 1000, market: 960, inEnvironment: 96, selected: 43, target: 22, unclassified: 41 });
    expect(map.environment.companies).toEqual({ count: 250, total: 250 });
    expect(map.shortlist).toHaveLength(5);

    // Ranked by the free per-company count: Beta (30) > Gamma (12) > Alpha (4); trends only for the top 2.
    expect(map.companies.map((row) => [row.company.name, row.pool, row.shortlisted])).toEqual([
      ['Beta Ledger', 30, 2],
      ['Gamma Cards', 12, 1],
      ['Alpha Payments', 4, 2],
    ]);
    expect(api.callsTo('/v2/companies/workforce').map((call) => call.query.id)).toEqual(['co-beta', 'co-gamma']);
    expect(map.companies[0]?.trend).toMatchObject({ headcount: 120, change: 20, direction: 'up' });
    expect(map.companies[2]?.trend).toBeUndefined();

    expect(map.credits.spent).toBe(5 * 2 + 2);
    expect(map.credits.balanceBefore).toBe(900);
    expect(map.credits.balanceAfter).toBe(900 - 12);
  });

  it('counts per-company pools with the shortlist filters plus the company id', async () => {
    const { api, promise } = run();
    await promise;
    const companyCounts = api.callsTo('/v2/people/search/count').filter((call) => call.body?.filter?.companyId);
    expect(companyCounts).toHaveLength(3);
    expect(companyCounts[0]?.body).toEqual({
      filter: {
        position: ['data engineer'],
        department: ['engineering-technical/data-science'],
        seniority: ['senior', 'director'],
        currentCompanyStartDate: { before: '2024-11-11' },
        companyId: 'co-alpha',
      },
    });
  });

  it('makes no paid calls on a dry run and reports the estimate', async () => {
    const { api, lines, promise } = run({ dryRun: true });
    const map = await promise;
    expect(api.paidCalls()).toEqual([]);
    expect(map.status).toBe('dry-run');
    expect(map.credits.spent).toBe(0);
    expect(map.credits.estimate.map((line) => line.credits)).toEqual([10, 2]);
    expect(lines.join('\n')).toContain('Dry run: no paid calls made.');
  });

  it('stops before any paid call when the estimate is over --max-credits, keeping the free sizing', async () => {
    const { api, promise } = run({ maxCredits: 11 });
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunStoppedError);
    const { map, cause } = error as RunStoppedError;
    expect(cause).toBeInstanceOf(BudgetExceededError);
    expect(api.paidCalls()).toEqual([]);
    expect(map).toMatchObject({ status: 'stopped', shortlist: [], credits: { spent: 0 } });
    expect(map.sizing.target).toBe(22);
  });

  it('keeps the paid shortlist when a team-trend lookup fails, and never lets the SDK retry that paid GET', async () => {
    const api = fakeApi({ maxRetries: 2, workforceErrors: { 'co-beta': 500 } });
    const error = await run({}, api).promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunStoppedError);
    const { map } = error as RunStoppedError;

    expect(api.callsTo('/v2/companies/workforce').filter((call) => call.query.id === 'co-beta')).toHaveLength(1);
    expect(map.status).toBe('stopped');
    expect(map.stoppedBecause).toContain('500');
    expect(map.shortlist).toHaveLength(5);
    expect(map.companies.map((row) => row.company.name)).toEqual(['Beta Ledger', 'Gamma Cards', 'Alpha Payments']);
    expect(map.companies[1]?.trend?.headcount).toBe(40); // Gamma's lookup finished and is kept
    expect(map.credits.spent).toBe(10 + 1);
    expect(renderReport(map)).toContain('The run stopped early');
  });

  it('skips the paid steps when nobody matches every filter', async () => {
    const api = fakeApi({ peopleCount: (body) => (body.filter?.currentCompanyStartDate ? 0 : defaultPeopleCount(body)) });
    const map = await run({}, api).promise;
    expect(map.status).toBe('no-matches');
    expect(api.paidCalls()).toEqual([]);
    expect(map.credits.estimate).toEqual([]);
  });

  it('explains an unknown role with autocomplete suggestions instead of searching', async () => {
    const api = fakeApi({ positions: { 'data enginer': ['Data Engineering Intern'] }, peopleCount: () => 0 });
    await expect(run({ roles: ['data enginer'] }, api).promise).rejects.toThrow(
      new UsageError('No profile has a current title containing "data enginer". Try: Data Engineering Intern.'),
    );
    expect(api.paidCalls()).toEqual([]);
  });

  it('drops the department filter when it would hide most people with the title', async () => {
    const api = fakeApi({ peopleCount: (body) => (body.filter?.department ? 100 : defaultPeopleCount(body)) });
    const map = await run({ dryRun: true }, api).promise;
    expect(map.role.departments).toEqual([]);
    expect(map.role.droppedDepartments).toEqual(['engineering-technical/data-science']);
    expect(map.role.departmentCoverage).toBe(0.1);
    expect(map.role.trendScope).toBe('whole company');
    expect(map.sizing.market).toBe(1000);
  });

  it('rejects an unknown technology before any count or paid call, instead of widening the search', async () => {
    const api = fakeApi({ technologies: { snowflake: ['snowflake'], dbt: [], react: ['react native'] } });
    await expect(run({ environment: { technologies: ['dbt'], employees: [] } }, api).promise).rejects.toThrow(
      new UsageError('Unknown technology "dbt": it is not in the CompanyEnrich technology list. Remove it from --technologies.'),
    );
    await expect(run({ environment: { technologies: ['snowflake', 'react'], employees: [] } }, api).promise).rejects.toThrow(
      'Did you mean react native?',
    );
    expect(api.callsTo('/v2/companies/search/count')).toEqual([]);
    expect(api.paidCalls()).toEqual([]);
  });

  it('sizes the paid page by the free count, so a small pool cannot overspend the cap', async () => {
    const onlyOne = (body: Record<string, any>) => (body.filter?.currentCompanyStartDate && !body.filter?.companyId ? 1 : defaultPeopleCount(body));

    const fits = fakeApi({ peopleCount: onlyOne });
    const map = await run({ people: 5, trendTop: 0, maxCredits: 2 }, fits).promise;
    expect(fits.callsTo('/v2/people/search')[0]?.body?.pageSize).toBe(1);
    expect(map.credits.estimate).toEqual([{ step: 'shortlist', detail: '1 profile x 2', credits: 2 }]);
    expect(map.credits.spent).toBe(2);

    const over = fakeApi({ peopleCount: onlyOne });
    await expect(run({ people: 5, trendTop: 1, maxCredits: 2 }, over).promise).rejects.toThrow(RunStoppedError);
    expect(over.paidCalls()).toEqual([]);
  });

  it('keeps the paid results when the closing balance check fails', async () => {
    const api = fakeApi({ meFailsAfter: 1 });
    const map = await run({}, api).promise;
    expect(map.status).toBe('complete');
    expect(map.shortlist).toHaveLength(5);
    expect(map.credits.spent).toBe(12);
    expect(map.credits.balanceAfter).toBeUndefined();
  });

  it('searches the whole market when no company environment is given', async () => {
    const { api, promise } = run({ dryRun: true, environment: { technologies: [], employees: [] } });
    const map = await promise;
    expect(api.callsTo('/v2/companies/search/count')).toEqual([]);
    expect(map.environment.description).toBe('any company');
    expect(map.sizing.inEnvironment).toBe(map.sizing.market);
    expect(map.notes).toEqual([]);
  });

  it('does not charge for a company without workforce data', async () => {
    const api = fakeApi({ workforce: {} });
    const map = await run({}, api).promise;
    expect(map.companies.every((row) => row.trend === undefined)).toBe(true);
    expect(map.credits.spent).toBe(10);
  });

  it('merges duplicate profiles before grouping, but still records the billed count', async () => {
    const [first] = PEOPLE;
    const api = fakeApi({ people: [...PEOPLE, { ...first!, id: 99, socials: { linkedinUrl: 'https://www.linkedin.com/in/candidate-1-b' } }] });
    const map = await run({ people: 6 }, api).promise;
    expect(map.shortlist).toHaveLength(5);
    expect(map.companies.find((row) => row.company.name === 'Alpha Payments')?.shortlisted).toBe(2);
    expect(map.credits.entries[0]?.credits).toBe(12);
    expect(map.notes).toContain('Merged 1 duplicate profile (same person id, or same name, company and start date): the shortlist has 5 people.');
  });

  it('never uses the preview endpoints', async () => {
    const { api, promise } = run();
    await promise;
    expect(api.calls.filter((call) => call.path.endsWith('/preview'))).toEqual([]);
  });
});
