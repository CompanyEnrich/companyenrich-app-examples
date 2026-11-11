import { describe, expect, it } from 'vitest';
import { findPreset } from '../src/lib/blueprints';
import { buildCoverage } from '../src/lib/coverage';
import { CreditBudget, estimateCredits } from '../src/lib/credits';
import { assignPeople, mapCommittee } from '../src/lib/mapping';
import { UserFacingError } from '../src/lib/user-error';
import type { MappedPerson, RoleSpec } from '../src/lib/types';
import { errorResponse, fakeApi, person, type FakeCompany } from './fake-api';

const now = new Date('2026-11-10T00:00:00Z');
const devtools = findPreset('devtools')!;
const security = findPreset('security')!;

function companies(): FakeCompany[] {
  return [
    {
      domain: 'big.com',
      name: 'Big',
      employees: '1K-5K',
      people: [
        person('big.com', { seniority: 'c-suite', department: 'c-suite/information-technology-executive', title: 'CTO' }),
        person('big.com', { seniority: 'vp', department: 'engineering-technical/software-development', title: 'VP Engineering', start: '2026-09-01' }),
        person('big.com', { seniority: 'manager', department: 'engineering-technical/software-development', title: 'Engineering Manager' }),
        person('big.com', { seniority: 'manager', department: 'engineering-technical/software-development', title: 'Engineering Manager, Payments' }),
        person('big.com', { seniority: 'senior', department: 'engineering-technical/devops', title: 'Senior Platform Engineer' }),
        person('big.com', { seniority: 'head', department: 'information-technology/information-security', title: 'Head of Security' }),
        person('big.com', { seniority: 'manager', department: 'finance/sourcing-procurement', title: 'Procurement Manager' }),
      ],
    },
    {
      domain: 'tiny.io',
      name: 'Tiny',
      employees: '11-50',
      people: [
        person('tiny.io', { seniority: 'founder', department: 'c-suite/founder', title: 'Co-founder & CEO' }),
        person('tiny.io', { seniority: 'c-suite', department: 'c-suite/information-technology-executive', title: 'CTO' }),
        // Investors often carry a "founder" seniority at portfolio companies; roleFilter excludes them.
        person('tiny.io', { seniority: 'founder', department: 'c-suite/founder', title: 'Angel Investor' }),
      ],
    },
    {
      domain: 'mid.dev',
      name: 'Mid',
      employees: '51-200',
      people: [
        person('mid.dev', { seniority: 'vp', department: 'engineering-technical/software-development', title: 'VP Engineering' }),
        person('mid.dev', { seniority: 'c-suite', department: 'c-suite/executive', title: 'CEO' }),
      ],
      headcount: { cSuite: 1, engineeringTechnical: 1, informationTechnology: 0, legal: 0 },
    },
  ];
}

describe('buildCoverage (free step)', () => {
  it('counts every role per account without a single paid call', async () => {
    const api = fakeApi(companies());
    const plan = await buildCoverage(api.client, ['big.com', 'tiny.io', 'mid.dev', 'nowhere.org'], devtools);

    expect(api.paidCalls()).toHaveLength(0);
    expect(plan.unresolved).toEqual([{ domain: 'nowhere.org', reason: expect.stringMatching(/No company/) }]);

    const [big, tiny, mid] = plan.accounts;
    expect(big!.account.band).toBe('large');
    expect(Object.fromEntries(big!.roles.map(({ role, count }) => [role.key, count]))).toEqual({
      'economic-buyer': 2,
      champion: 2,
      'technical-evaluator': 1,
      'security-review': 1,
      'end-user-lead': 0,
      'procurement-legal': 1,
    });
    expect(tiny!.roles.map(({ role, count }) => [role.key, count])).toEqual([['economic-buyer', 2], ['champion', 0]]); // investor excluded
    expect(tiny!.singleThreaded).toBe(true);
    expect(mid!.singleThreaded).toBe(true);
    expect(big!.singleThreaded).toBe(false);
  });
});

describe('estimateCredits', () => {
  it('charges min(limit, count) x 2 per role and skips empty roles', async () => {
    const api = fakeApi(companies());
    const plan = await buildCoverage(api.client, ['big.com', 'tiny.io'], devtools);
    const estimate = estimateCredits(plan, { workforce: false });
    // big: buyer 1, champion 2, evaluator 1, security 1, procurement 1 = 6 people; tiny: founders 2.
    expect(estimate.searchCredits).toBe(16);
    expect(estimate.maxCredits).toBe(16);
    expect(estimateCredits(plan, { workforce: true }).workforceCredits).toBe(2);
  });
});

describe('mapCommittee (paid step)', () => {
  it('searches only roles with matches, lists gaps and stays within the estimate', async () => {
    const api = fakeApi(companies());
    const plan = await buildCoverage(api.client, ['big.com', 'tiny.io'], devtools);
    const estimate = estimateCredits(plan, { workforce: false });
    const map = await mapCommittee(api.client, plan, { workforce: false, budget: new CreditBudget(estimate.maxCredits), now });

    // big.com has 5 roles with matches (end users has 0), tiny.io has 1.
    const searches = api.calls.filter((call) => call.path === '/v2/people/search');
    expect(searches).toHaveLength(6);
    expect(searches.every((call) => Number(call.body!.pageSize) <= 2)).toBe(true);
    expect(map.creditsSpent).toBe(api.creditsUsed());
    expect(map.creditsSpent).toBeLessThanOrEqual(estimate.maxCredits);

    const big = map.accounts[0]!;
    const buyer = big.roles.find(({ role }) => role.key === 'economic-buyer')!;
    expect(buyer.people.map((p) => p.title)).toEqual(['CTO']);
    expect(big.gaps.map((gap) => gap.roleKey)).toEqual(['end-user-lead']);
    expect(big.gaps[0]!.suggestion).toMatch(/team/);

    const tiny = map.accounts[1]!;
    expect(tiny.roles[0]!.people).toHaveLength(2);
    expect(tiny.gaps).toEqual([expect.objectContaining({ roleKey: 'champion', reason: expect.stringMatching(/No one at Tiny matches/) })]);
  });

  it('refuses to start when the cap is below the guaranteed cost', async () => {
    const api = fakeApi(companies());
    const plan = await buildCoverage(api.client, ['big.com'], devtools);
    await expect(mapCommittee(api.client, plan, { workforce: false, budget: new CreditBudget(3), now })).rejects.toBeInstanceOf(UserFacingError);
    expect(api.paidCalls()).toHaveLength(0);
  });

  it('uses the workforce check to relabel or skip roles whose team does not exist', async () => {
    const api = fakeApi(companies());
    const plan = await buildCoverage(api.client, ['mid.dev'], security);
    const estimate = estimateCredits(plan, { workforce: true });
    const map = await mapCommittee(api.client, plan, { workforce: true, budget: new CreditBudget(estimate.maxCredits), now });
    const mid = map.accounts[0]!;

    const buyer = mid.roles.find(({ role }) => role.key === 'economic-buyer')!;
    expect(buyer.notes[0]).toMatch(/No IT and security team observed/);
    expect(buyer.people.map((p) => p.title)).toEqual(['CEO']);

    const champion = mid.gaps.find((gap) => gap.roleKey === 'champion')!;
    expect(champion.reason).toMatch(/already mapped/);
    expect(mid.gaps.find((gap) => gap.roleKey === 'end-user-lead')!.reason).toMatch(/no end-user team/);
    expect(map.creditsSpent).toBe(api.creditsUsed());
    expect(map.creditsSpent).toBeLessThanOrEqual(estimate.maxCredits);
  });
});

describe('assignPeople', () => {
  const role = (key: string, priority: number, limit = 1): RoleSpec => ({
    key, label: key, why: '', department: [], seniority: ['vp'], position: [], limit, priority,
  });
  const someone = (id: string): MappedPerson => ({
    id, name: id, title: '', seniority: 'vp', department: null, roleStartDate: null, monthsInRole: 12, newInRole: false, linkedinUrl: null,
  });

  it('gives each person to the highest-priority role only', () => {
    const { results, gaps } = assignPeople(
      [
        { role: role('champion', 2), count: 1, candidates: [someone('a')], notes: [] },
        { role: role('economic-buyer', 1), count: 2, candidates: [someone('a'), someone('b')], notes: [] },
      ],
      { domain: 'x.com', name: 'X', companyId: 'x', employees: null, band: 'unknown' },
    );
    expect(results.map((r) => [r.role.key, r.people.map((p) => p.id)])).toEqual([['economic-buyer', ['a']], ['champion', []]]);
    expect(gaps[0]!.reason).toMatch(/already mapped as economic-buyer/);
  });
});

describe('mapCommittee failure and concurrency', () => {
  it('keeps people already paid for when a paid call fails midway', async () => {
    const api = fakeApi(companies(), {
      respond: (path, nth) => (path === '/v2/people/search' && nth === 3 ? errorResponse(402) : null),
    });
    const plan = await buildCoverage(api.client, ['big.com'], devtools);
    const budget = new CreditBudget(100);
    const map = await mapCommittee(api.client, plan, { workforce: false, budget, now });

    expect(map.stoppedEarly).toMatch(/out of credits/);
    // Economic buyer (1 person) and champion (2 people) were paid for before the 402.
    expect(map.creditsSpent).toBe(6);
    expect(budget.spent).toBe(6);
    const big = map.accounts[0]!;
    expect(big.roles.find(({ role }) => role.key === 'champion')!.people).toHaveLength(2);
    expect(big.gaps.find((gap) => gap.roleKey === 'procurement-legal')!.reason).toMatch(/run stopped/);
    expect(api.calls.filter((call) => call.path === '/v2/people/search')).toHaveLength(3);
  });

  it('never has more than 4 requests in flight across all accounts', async () => {
    const many: FakeCompany[] = Array.from({ length: 6 }, (_, index) => ({
      ...companies()[2]!,
      domain: `mid${index}.dev`,
      people: companies()[2]!.people.map((p) => ({
        ...p,
        experiences: p.experiences.map((e) => ({ ...e, company: { id: `id-${index}`, name: 'Mid', domain: `mid${index}.dev` } })),
      })),
    }));
    const api = fakeApi(many, { delayMs: 5 });
    const plan = await buildCoverage(api.client, many.map((c) => c.domain), security);
    const map = await mapCommittee(api.client, plan, { workforce: true, budget: new CreditBudget(500), now });

    expect(map.stoppedEarly).toBeNull();
    expect(api.paidCalls().length).toBeGreaterThan(6);
    expect(api.maxInFlight()).toBeLessThanOrEqual(4);
    expect(api.maxInFlight()).toBeGreaterThan(1);
  });
});

describe('CreditBudget', () => {
  it('counts a child request against the parent cap', () => {
    const server = new CreditBudget(10);
    const first = server.child(8);
    expect(first.reserve(8)).toBe(true);
    first.settle(8, 6);
    expect(server.available).toBe(4);

    const second = server.child(8);
    expect(second.available).toBe(4);
    expect(second.reserve(6)).toBe(false);
    expect(second.reserve(4)).toBe(true);
    second.settle(4, 4);
    expect(server.spent).toBe(10);
    expect(server.available).toBe(0);
  });
});
