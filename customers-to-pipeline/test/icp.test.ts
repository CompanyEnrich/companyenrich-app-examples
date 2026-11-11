import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/lib/errors.js';
import { deriveIcp, matchDimensions, parseIcpFile } from '../src/lib/icp.js';
import { buildProfile } from '../src/lib/profile.js';
import { CUSTOMERS, INDUSTRY_CODES, makeCompany } from './fake-api.js';

describe('buildProfile', () => {
  const profile = buildProfile(CUSTOMERS);

  it('counts each value once per company and keeps missing data separate', () => {
    expect(profile.customers).toBe(10);
    expect(profile.dimensions.employees).toEqual([
      { value: '51-200', customers: 2, share: 0.2 },
      { value: '201-500', customers: 4, share: 0.4 },
      { value: '1K-5K', customers: 3, share: 0.3 },
    ]);
    expect(profile.unknown.employees).toBe(1);
    expect(profile.unknown.technologies).toBe(10);
  });

  it('counts every industry listed on a company and buckets founded years by decade', () => {
    expect(profile.dimensions.industry[0]).toEqual({ value: 'Software', customers: 8, share: 0.8 });
    expect(profile.dimensions.foundedYear.map((row) => [row.value, row.customers])).toEqual([
      ['2000s', 1],
      ['2010s', 6],
      ['2020s', 3],
    ]);
  });
});

describe('deriveIcp', () => {
  it('keeps values shared by at least --min-share of customers, one rule per dimension', () => {
    const { filter, selected } = deriveIcp(buildProfile(CUSTOMERS), 0.3, INDUSTRY_CODES);
    expect(filter).toEqual({
      naicsCodes: ['5112', '5132', '334614'], // Software (80%) mapped to NAICS
      categories: { in: ['b2b', 'saas'] }, // "in" = any category
      employees: ['201-500', '501-1K', '1K-5K'], // 40% and 30% (inclusive), gap filled
      country: ['US'], // 70%; GB at 20% is left out
      foundedYear: { min: 2010, max: 2029 }, // 2010s (60%) and 2020s (30%)
    });
    // revenue: 20% per range is below 30%, so revenue does not constrain the search
    expect(selected.revenue).toBeUndefined();
    expect(selected.industry).toEqual(['Software']);
  });

  it('tightens as --min-share rises', () => {
    const { filter } = deriveIcp(buildProfile(CUSTOMERS), 0.5, INDUSTRY_CODES);
    expect(filter.employees).toBeUndefined();
    expect(filter.foundedYear).toEqual({ min: 2010, max: 2019 });
    expect(filter.categories).toEqual({ in: ['b2b', 'saas'] });
  });

  it('adds technologies only when customers have technology data', () => {
    const withTech = CUSTOMERS.map((company, index) => ({
      ...company,
      technologies: index < 4 ? ['Next-Js', 'Segment'] : ['Segment'],
    }));
    expect(deriveIcp(buildProfile(withTech), 0.3, INDUSTRY_CODES).filter.technologies).toEqual({ in: ['Segment', 'Next-Js'] });
  });

  it('returns an empty filter when no value is common enough', () => {
    const scattered = ['a', 'b', 'c', 'd'].map((name, index) =>
      makeCompany(`${name}.example`, { location: { country: { code: ['US', 'GB', 'DE', 'FR'][index] ?? 'US', name } } }),
    );
    expect(deriveIcp(buildProfile(scattered), 0.3, INDUSTRY_CODES).filter).toEqual({});
  });
});

describe('matchDimensions', () => {
  const icp = deriveIcp(buildProfile(CUSTOMERS), 0.3, INDUSTRY_CODES).filter;

  it('lists the ICP dimensions a company matches, by readable name', () => {
    const fit = makeCompany('fit.example', {
      industries: ['Software'],
      categories: ['saas'],
      employees: '501-1K',
      location: { country: { code: 'US', name: 'United States' } },
      foundedYear: 2017,
    });
    expect(matchDimensions(fit, icp, INDUSTRY_CODES)).toEqual({
      matched: ['industry', 'categories', 'employees', 'country', 'foundedYear'],
      checked: 5,
    });
  });

  it('skips dimensions the company has no data for instead of counting them as misses', () => {
    const sparse = makeCompany('sparse.example', { employees: '11-50' });
    expect(matchDimensions(sparse, icp, INDUSTRY_CODES)).toEqual({ matched: [], checked: 1 });
  });

  it('treats a plain categories array as "every category", like the API', () => {
    const b2bOnly = makeCompany('b2b.example', { categories: ['b2b'] });
    expect(matchDimensions(b2bOnly, { categories: ['b2b', 'saas'] }, INDUSTRY_CODES).matched).toEqual([]);
    expect(matchDimensions(b2bOnly, { categories: { in: ['b2b', 'saas'] } }, INDUSTRY_CODES).matched).toEqual(['categories']);
  });
});

describe('parseIcpFile', () => {
  it('reads the filter from an icp.json', () => {
    expect(parseIcpFile('{"filter": {"country": ["US"]}, "about": "x"}', 'icp.json')).toEqual({ country: ['US'] });
  });

  it('explains a file without a filter object', () => {
    expect(() => parseIcpFile('{"country": ["US"]}', 'icp.json')).toThrow(UsageError);
    expect(() => parseIcpFile('{not json', 'icp.json')).toThrow(/not valid JSON/);
  });

  it.each([
    ['{"filter": {"industry": "Software"}}', /unknown filter field "industry".*Did you mean naicsCodes/],
    ['{"filter": {"employee": ["201-500"]}}', /unknown filter field "employee".*Did you mean employees\?/],
    ['{"filter": {"categories": {"any": ["saas"]}}}', /"categories" has an unknown key "any"; use in, notIn, all/],
    ['{"filter": {"country": {"all": ["US"]}}}', /"country" has an unknown key "all"; use in, notIn\./],
    ['{"filter": {"foundedYear": {"from": 2010}}}', /"foundedYear" has an unknown key "from"; use min, max/],
    ['{"filter": {"workforceGrowth": {"periods": "y1"}}}', /"workforceGrowth" has an unknown key "periods"/],
    ['{"filter": {"workforceSize": [{"department": "sales", "minimum": 5}]}}', /"workforceSize\[0\]" has an unknown key "minimum"/],
  ])('rejects unknown keys: %s', (text, message) => {
    expect(() => parseIcpFile(text, 'icp.json')).toThrow(message);
  });

  it('accepts every advanced form the API supports', () => {
    const filter = {
      naicsCodes: { in: ['5112'], all: ['5112'] },
      country: { notIn: ['CN'] },
      foundedYear: { min: 2010, max: 2019 },
      workforceGrowth: { period: 'y1', department: 'sales', min: 0.1 },
      workforceSize: [{ department: 'engineering_technical', min: 10, max: 200 }],
    };
    expect(parseIcpFile(JSON.stringify({ filter }), 'icp.json')).toEqual(filter);
  });
});
