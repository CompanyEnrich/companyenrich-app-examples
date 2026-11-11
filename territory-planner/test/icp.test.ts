import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/lib/errors.js';
import { describeIcp, loadIcp, parseIcp } from '../src/lib/icp.js';

describe('ICP filter validation', () => {
  it('accepts the shipped example', async () => {
    const icp = await loadIcp(new URL('../examples/icp.json', import.meta.url).pathname);
    expect(icp).toEqual({ categories: ['b2b', 'saas'], employees: ['51-200', '201-500'] });
    expect(describeIcp(icp)).toBe('categories: b2b, saas · employees: 51-200, 201-500');
  });

  it('accepts single values, arrays and advanced objects', () => {
    expect(() =>
      parseIcp(
        {
          employees: '51-200',
          revenue: { in: ['10m-50m'], notIn: ['over-1b'] },
          categories: { all: ['b2b', 'saas'] },
          type: ['private'],
          naicsCodes: ['5112'],
          technologies: { all: ['salesforce'] },
          foundedYear: { min: 2010 },
          domain: { notIn: ['example.com'] },
        },
        'icp.json',
      ),
    ).not.toThrow();
  });

  it('rejects an unknown enum value and lists the allowed ones', () => {
    expect(() => parseIcp({ employees: ['50-200'] }, 'icp.json')).toThrow(/"employees" has unknown value "50-200"\. Allowed: 1-10, 11-50/);
    expect(() => parseIcp({ revenue: { in: ['10M-50M'] } }, 'icp.json')).toThrow(UsageError);
    expect(() => parseIcp({ categories: { any: ['saas'] } }, 'icp.json')).toThrow(/"categories" has unknown key "any" \(allowed: in, notIn, all\)/);
  });

  it('rejects geography, which the planner sets itself', () => {
    for (const field of ['country', 'state', 'city', 'region']) {
      expect(() => parseIcp({ [field]: 'x' }, 'icp.json')).toThrow(new RegExp(`remove "${field}"; the planner sets the country`));
    }
  });

  it('points industry filters to naicsCodes', () => {
    expect(() => parseIcp({ industry: 'Software' }, 'icp.json')).toThrow(/naicsCodes/);
  });

  it('rejects typo\'d keys and suggests the right field', () => {
    expect(() => parseIcp({ employee: ['51-200'] }, 'icp.json')).toThrow(/"employee" is not a v2 company filter field; did you mean "employees"\?/);
    expect(() => parseIcp({ technology: 'salesforce' }, 'icp.json')).toThrow(/did you mean "technologies"/);
    expect(() => parseIcp({ industries: ['Software'] }, 'icp.json')).toThrow(/use "naicsCodes" .* or "categories"/);
    expect(() => parseIcp({ constructor: 1 }, 'icp.json')).toThrow(/"constructor" is not a v2 company filter field/);
  });

  it('checks keys inside advanced objects, per field', () => {
    expect(() => parseIcp({ keywords: { any: ['crm'] } }, 'icp.json')).toThrow(/"keywords" has unknown key "any"/);
    // Only collection fields take "all"; employees takes in and notIn.
    expect(() => parseIcp({ employees: { all: ['51-200'] } }, 'icp.json')).toThrow(/"employees" has unknown key "all" \(allowed: in, notIn\)/);
    expect(() => parseIcp({ require: { in: ['linkedin'] } }, 'icp.json')).toThrow(/"require" has unknown key "in" \(allowed: all\)/);
    expect(() => parseIcp({ domain: { notIn: 'example.com' } }, 'icp.json')).toThrow(/"domain.notIn" must be an array/);
  });

  it('checks workforce and range sub-keys and values', () => {
    expect(() => parseIcp({ workforceGrowth: { period: 'y1', minimum: 0.1 } }, 'icp.json')).toThrow(/"workforceGrowth" has unknown key "minimum"/);
    expect(() => parseIcp({ workforceGrowth: { period: '12m' } }, 'icp.json')).toThrow(/"workforceGrowth.period" has unknown value "12m"\. Allowed: m6, y1, y2/);
    expect(() => parseIcp({ workforceSize: [{ department: 'sales', minimum: 5 }] }, 'icp.json')).toThrow(/"workforceSize\[0\]" has unknown key "minimum"/);
    expect(() => parseIcp({ workforceSize: [{ department: 'Sales' }] }, 'icp.json')).toThrow(/"workforceSize\[0\].department" has unknown value "Sales"/);
    expect(() => parseIcp({ foundedYear: { from: 2015 } }, 'icp.json')).toThrow(/"foundedYear" has unknown key "from" \(allowed: min, max\)/);
    expect(() => parseIcp({ naicsCodes: ['0511'] }, 'icp.json')).toThrow(/not a NAICS code/);
    expect(() =>
      parseIcp({ workforceGrowth: { period: 'y1', department: 'sales', min: 0.1 }, workforceSize: [{ department: 'engineering_technical', min: 5, max: 50 }], fundingAmount: { min: 1_000_000 } }, 'icp.json'),
    ).not.toThrow();
  });

  it('rejects unknown fields and non-objects', () => {
    expect(() => parseIcp({ headcount: '51-200' }, 'icp.json')).toThrow(/"headcount" is not a v2 company filter field/);
    expect(() => parseIcp(['saas'], 'icp.json')).toThrow(/expected a JSON object/);
  });

  it('explains a missing file or bad JSON in one line', async () => {
    await expect(loadIcp('does-not-exist.json')).rejects.toThrow(/Cannot read the ICP file/);
  });
});
