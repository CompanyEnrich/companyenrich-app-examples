import { describe, expect, it } from 'vitest';
import { EMPLOYEE_RANGES, REVENUE_RANGES } from '../src/lib/icp.js';
import {
  bandScheme,
  EMPLOYEE_MIDPOINTS,
  formatWeight,
  REVENUE_MIDPOINTS_USD_M,
  weightStates,
} from '../src/lib/weights.js';

describe('bandScheme', () => {
  it('counts only the employee bands the ICP allows', () => {
    expect(bandScheme('employees', { employees: ['51-200', '201-500'] })?.bands).toEqual(['51-200', '201-500']);
    expect(bandScheme('employees', { employees: '1K-5K' })?.bands).toEqual(['1K-5K']);
    expect(bandScheme('employees', { employees: { notIn: ['1-10', '11-50'] } })?.bands).toEqual(EMPLOYEE_RANGES.slice(2));
    expect(bandScheme('employees', { employees: { in: ['11-50', '51-200'], notIn: ['11-50'] } })?.bands).toEqual(['51-200']);
  });

  it('uses every band when the ICP does not filter on that field', () => {
    expect(bandScheme('revenue', { categories: 'saas' })?.bands).toEqual([...REVENUE_RANGES]);
    expect(bandScheme('none', {})).toBeNull();
  });

  it('has a documented midpoint for every band', () => {
    for (const band of EMPLOYEE_RANGES) expect(EMPLOYEE_MIDPOINTS[band]).toBeGreaterThan(0);
    for (const band of REVENUE_RANGES) expect(REVENUE_MIDPOINTS_USD_M[band]).toBeGreaterThan(0);
    // (low + high) / 2, and 1.5x the lower bound for the open-ended top band.
    expect(EMPLOYEE_MIDPOINTS['51-200']).toBe((51 + 200) / 2);
    expect(EMPLOYEE_MIDPOINTS['over-10K']).toBe(1.5 * 10_000);
    expect(REVENUE_MIDPOINTS_USD_M['10m-50m']).toBe((10 + 50) / 2);
    expect(REVENUE_MIDPOINTS_USD_M['over-1b']).toBe(1.5 * 1_000);
  });
});

describe('weightStates', () => {
  it('returns plain company counts when not weighting', () => {
    const result = weightStates([{ companies: 5, bands: {} }, { companies: 7, bands: {} }], null);
    expect(result.weights).toEqual([5, 7]);
  });

  it('multiplies each band count by its midpoint', () => {
    const scheme = bandScheme('employees', { employees: ['51-200', '201-500'] })!;
    const result = weightStates(
      [
        { companies: 12, bands: { '51-200': 10, '201-500': 2 } },
        { companies: 3, bands: { '51-200': 0, '201-500': 3 } },
      ],
      scheme,
    );
    expect(result.weights[0]).toBeCloseTo(10 * 125.5 + 2 * 350.5);
    expect(result.weights[1]).toBeCloseTo(3 * 350.5);
    expect(result.bandedCompanies).toBe(15);
  });

  it('weights companies with no band on file at the country-wide average midpoint', () => {
    const scheme = bandScheme('revenue', {})!;
    // State A: 4 companies, all banded. State B: 10 companies, none with a revenue band.
    const result = weightStates(
      [
        { companies: 4, bands: { '1m-10m': 2, '10m-50m': 2 } },
        { companies: 10, bands: {} },
      ],
      scheme,
    );
    const average = (2 * 5.5 + 2 * 30) / 4;
    expect(result.fallbackMidpoint).toBeCloseTo(average);
    expect(result.weights[0]).toBeCloseTo(2 * 5.5 + 2 * 30);
    expect(result.weights[1]).toBeCloseTo(10 * average);
  });

  it('never counts more unbanded companies than exist when live counts drift', () => {
    const scheme = bandScheme('employees', { employees: '51-200' })!;
    const result = weightStates([{ companies: 9, bands: { '51-200': 10 } }], scheme);
    expect(result.weights[0]).toBeCloseTo(10 * 125.5);
  });
});

describe('formatWeight', () => {
  it('formats companies, headcount and revenue', () => {
    expect(formatWeight(1593, 'none')).toBe('1,593');
    expect(formatWeight(0.47, 'none')).toBe('0.5');
    expect(formatWeight(290_412, 'employees')).toBe('290.4K');
    expect(formatWeight(1_250, 'revenue')).toBe('$1.3B');
  });
});
