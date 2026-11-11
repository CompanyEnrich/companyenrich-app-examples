import { describe, expect, it } from 'vitest';
import { toCompanyFacts, type CompanyFacts } from '../src/lib/company';
import { scoreCompany, requiredExpansions } from '../src/lib/score';
import { tierFor } from '../src/lib/tier';
import { companyFixture } from './fake-api';
import { NOW, shippedConfig } from './helpers';

const { scoring } = shippedConfig();
const facts = (overrides = {}): CompanyFacts => toCompanyFacts(companyFixture(overrides), ['financial', 'technologies']);

function pointsBy(company: CompanyFacts, config = scoring) {
  return Object.fromEntries(scoreCompany(company, config, NOW).factors.map((factor) => [factor.dimension, factor.points]));
}

describe('scoreCompany', () => {
  it('adds weight x match for every dimension and reports each factor', () => {
    const result = scoreCompany(facts(), scoring, NOW);
    expect(result.max).toBe(100);
    expect(pointsBy(facts())).toEqual({
      employees: 25,
      revenue: 15,
      categories: 15,
      country: 10,
      foundedYear: 5,
      funding: 10.5, // series_f 0.7, 13 months ago (recent) x 15
      technologies: 12, // Salesforce 0.5 + Marketo 0.3 = 0.8 x 15
    });
    expect(result.total).toBe(92.5);

    const funding = result.factors.find((factor) => factor.dimension === 'funding');
    expect(funding).toMatchObject({ value: 'Series F, 13 months ago', match: 0.7, weight: 15 });
    expect(result.factors.find((factor) => factor.dimension === 'technologies')?.reason).toBe('Marketo 0.3 + Salesforce 0.5');
  });

  it('uses the best category and the "other" match for unlisted values', () => {
    const result = scoreCompany(facts({ categories: ['b2c', 'b2b'], location: { country: { code: 'BR', name: 'Brazil' } } }), scoring, NOW);
    const byDimension = Object.fromEntries(result.factors.map((factor) => [factor.dimension, factor]));
    expect(byDimension.categories).toMatchObject({ match: 0.8, points: 12, reason: 'Best category is b2b (0.8)' });
    expect(byDimension.country).toMatchObject({ value: 'BR', match: 0.2, points: 2 });
  });

  it('scores missing data with the "unknown" match', () => {
    const company = facts({ employees: null, revenue: null, foundedYear: null, financial: null, technologies: [] });
    expect(pointsBy(company)).toMatchObject({ employees: 0, revenue: 3, foundedYear: 0, funding: 0, technologies: 0 });
  });

  it('applies the stale multiplier to old funding rounds', () => {
    const company = facts({ financial: { fundingStage: 'series_b', fundingDate: '2020-01-15T00:00:00' } });
    const funding = scoreCompany(company, scoring, NOW).factors.find((factor) => factor.dimension === 'funding');
    expect(funding).toMatchObject({ match: 0.5, points: 7.5 });
  });

  it('caps the technology match at 1 and matches names loosely', () => {
    const company = facts({ technologies: ['salesforce', 'Hub-Spot', 'MARKETO'] });
    const tech = scoreCompany(company, scoring, NOW).factors.find((factor) => factor.dimension === 'technologies');
    expect(tech).toMatchObject({ match: 1, points: 15 });
    expect(tech?.reason).toContain('capped at 1');
  });

  it('treats an expansion that was not requested as unknown, not as zero data', () => {
    const company = toCompanyFacts(companyFixture(), []);
    expect(company.funding).toBeUndefined();
    const funding = scoreCompany(company, scoring, NOW).factors.find((factor) => factor.dimension === 'funding');
    expect(funding?.reason).toContain('Not fetched');
  });
});

describe('requiredExpansions', () => {
  it('requests financial and technologies only for dimensions with weight', () => {
    expect(requiredExpansions(scoring)).toEqual(['financial', 'technologies']);
    const noFunding = structuredClone(scoring);
    noFunding.dimensions.funding.weight = 0;
    expect(requiredExpansions(noFunding)).toEqual(['technologies']);
  });
});

describe('tierFor', () => {
  const tiers = { A: 70, B: 50, C: 30 };
  it.each([
    [92.5, 'A'],
    [70, 'A'],
    [69.9, 'B'],
    [50, 'B'],
    [30, 'C'],
    [29.9, 'unqualified'],
    [0, 'unqualified'],
  ])('%s -> %s', (score, tier) => {
    expect(tierFor(score, tiers).tier).toBe(tier);
  });

  it('explains the threshold it used', () => {
    expect(tierFor(72, tiers).reason).toBe('72 >= 70, the tier A minimum');
    expect(tierFor(12, tiers).reason).toBe('12 < 30, the tier C minimum');
  });
});
