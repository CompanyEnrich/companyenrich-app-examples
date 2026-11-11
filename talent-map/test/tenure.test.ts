import { describe, expect, it } from 'vitest';
import { toCandidate } from '../src/lib/shortlist.js';
import { formatTenure, subtractMonths, tenureCutoff, yearsSince } from '../src/lib/tenure.js';
import { COMPANIES, makePerson } from './fake-api.js';

const NOW = new Date('2026-11-11T09:30:00Z');

describe('tenureCutoff', () => {
  it('subtracts whole years', () => {
    expect(tenureCutoff(NOW, 2)).toBe('2024-11-11');
  });

  it('rounds fractional years to months', () => {
    expect(tenureCutoff(NOW, 1.5)).toBe('2025-05-11');
    expect(tenureCutoff(NOW, 0.25)).toBe('2026-08-11');
  });

  it('clamps to the last day of shorter months, including leap years', () => {
    expect(subtractMonths(new Date('2026-03-31T00:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(tenureCutoff(new Date('2024-02-29T00:00:00Z'), 1)).toBe('2023-02-28');
    expect(tenureCutoff(new Date('2026-01-15T00:00:00Z'), 1.5)).toBe('2024-07-15');
  });
});

describe('yearsSince and formatTenure', () => {
  it('measures and formats time at a company', () => {
    expect(yearsSince('2024-11-11', NOW)).toBeCloseTo(2, 2);
    expect(formatTenure(yearsSince('2023-07-01', NOW))).toBe('3 yr 4 mo');
    expect(formatTenure(2)).toBe('2 yr');
    expect(formatTenure(0.5)).toBe('6 mo');
    expect(formatTenure(0.02)).toBe('under 1 mo');
  });

  it('returns NaN for an unparseable date and never a negative duration', () => {
    expect(yearsSince('not a date', NOW)).toBeNaN();
    expect(yearsSince('2027-01-01', NOW)).toBe(0);
  });
});

describe('toCandidate', () => {
  it('starts tenure at the earliest role at the current company, not the latest promotion', () => {
    const candidate = toCandidate(makePerson(7, COMPANIES.alpha, '2021-03-01'), NOW);
    expect(candidate.joinedCompany).toBe('2021-03-01');
    expect(candidate.tenureYears).toBeCloseTo(5.7, 1);
    expect(candidate.company).toEqual(COMPANIES.alpha);
    expect(candidate).toMatchObject({
      title: 'Senior Data Engineer', // the current role, not the headline
      headline: 'Senior Data Engineer | Spark | Snowflake',
      seniority: 'senior',
      location: 'Austin, Texas, United States',
    });
  });

  it('copes with a profile that has no current role', () => {
    const person = { ...makePerson(8, COMPANIES.beta), experiences: [] };
    const candidate = toCandidate(person, NOW);
    expect(candidate.company).toBeUndefined();
    expect(candidate.tenureYears).toBeUndefined();
  });
});
