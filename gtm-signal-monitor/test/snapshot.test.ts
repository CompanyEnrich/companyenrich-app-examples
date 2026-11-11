import { describe, expect, it } from 'vitest';
import { type CompanySnapshot, diffSnapshots, toSnapshot } from '../src/lib/snapshot.js';
import { fakeCompany } from './helpers/fake-api.js';

const base: CompanySnapshot = {
  capturedAt: '2026-11-01T00:00:00Z',
  name: 'Acme',
  employees: '201-500',
  revenue: '10m-50m',
  industry: 'Software',
  country: 'US',
  city: 'San Francisco',
  funding: { stage: 'series_a', date: '2025-02-01', total: 20_000_000 },
  technologies: ['React', 'Redshift', 'Stripe'],
  workforce: { observed: 400, departments: { engineeringTechnical: 120, sales: 40, legal: 2 } },
};

const diff = (after: Partial<CompanySnapshot>, before: CompanySnapshot = base) =>
  diffSnapshots(before, { ...before, ...after, capturedAt: '2026-11-08T00:00:00Z' }, { headcountChangePct: 10 });

describe('toSnapshot', () => {
  it('keeps only the fields the diff needs, and expansion fields only when requested', () => {
    const company = fakeCompany('acme.com', {
      name: 'Acme',
      technologies: ['Stripe', 'React', 'Stripe'],
      financial: { fundingStage: 'series_b', fundingDate: '2026-09-12T00:00:00Z', totalFunding: 65_000_000 },
    });
    expect(toSnapshot(company, ['financial', 'technologies'], '2026-11-08T00:00:00Z')).toEqual({
      capturedAt: '2026-11-08T00:00:00Z',
      name: 'Acme',
      employees: '201-500',
      revenue: '10m-50m',
      industry: 'Software',
      country: 'US',
      city: 'San Francisco',
      funding: { stage: 'series_b', date: '2026-09-12', total: 65_000_000 },
      technologies: ['React', 'Stripe'],
    });
    expect(toSnapshot(company, [], '2026-11-08T00:00:00Z')).not.toHaveProperty('funding');
  });
});

describe('diffSnapshots', () => {
  it('returns nothing when nothing changed', () => {
    expect(diff({})).toEqual([]);
  });

  it('reports range and text fields', () => {
    expect(diff({ employees: '501-1K', revenue: null, industry: 'Fintech' })).toEqual([
      'Employees: 201-500 → 501-1K',
      'Revenue: 10m-50m → unknown',
      'Industry: Software → Fintech',
    ]);
  });

  it('reports an HQ move', () => {
    expect(diff({ country: 'GB', city: 'London' })).toEqual(['HQ: San Francisco, US → London, GB']);
  });

  it('reports a new funding round and total', () => {
    expect(diff({ funding: { stage: 'series_b', date: '2026-09-12', total: 65_000_000 } })).toEqual([
      'Latest funding: Series A (2025-02-01) → Series B (2026-09-12)',
      'Total funding: $20M → $65M',
    ]);
  });

  it('reports technologies added and removed', () => {
    expect(diff({ technologies: ['React', 'Snowflake', 'Stripe', 'dbt'] })).toEqual([
      'Technologies added: Snowflake, dbt',
      'Technologies removed: Redshift',
    ]);
  });

  it('reports observed headcount changes at or above the threshold only', () => {
    expect(diff({ workforce: { observed: 430, departments: base.workforce!.departments } })).toEqual([]);
    expect(diff({ workforce: { observed: 460, departments: base.workforce!.departments } })).toEqual([
      'Observed headcount: 400 → 460 (+15.0%)',
    ]);
  });

  it('reports department changes that pass both the percentage and the 3-person floor', () => {
    // Sales -2 and legal +2 (+100%) are under the 3-person floor.
    const departments = { engineeringTechnical: 150, sales: 38, legal: 4, marketing: 5 };
    expect(diff({ workforce: { observed: 400, departments } })).toEqual([
      'Engineering headcount: 120 → 150 (+25.0%)',
      'Marketing headcount: 0 → 5 (new)',
    ]);
  });

  it('skips expansion fields missing from either snapshot', () => {
    const { funding, technologies, workforce, ...withoutExpansions } = base;
    expect(diffSnapshots(withoutExpansions, { ...base, technologies: ['Other'] }, { headcountChangePct: 10 })).toEqual([]);
  });
});
