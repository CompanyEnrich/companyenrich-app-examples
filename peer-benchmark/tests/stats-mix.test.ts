import { describe, expect, it } from 'vitest';
import { departmentMix } from '@/lib/mix';
import { median, percentileRank } from '@/lib/stats';
import { ACME, point, workforce } from './fixtures';

describe('median', () => {
  it('handles odd, even and empty lists without mutating them', () => {
    const values = [3, 1, 2];
    expect(median(values)).toBe(2);
    expect(values).toEqual([3, 1, 2]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('percentileRank', () => {
  it('counts peers below and splits ties', () => {
    expect(percentileRank(5, [1, 5, 9, 2])).toEqual({ below: 2, tied: 1, total: 4, percentile: 63 });
    expect(percentileRank(10, [1, 2])).toMatchObject({ below: 2, percentile: 100 });
    expect(percentileRank(0, [1, 2])).toMatchObject({ below: 0, percentile: 0 });
    expect(percentileRank(1, [])).toBeNull();
  });
});

describe('departmentMix', () => {
  it('divides each department and the unclassified count by observed headcount', () => {
    const mix = departmentMix(ACME)!;
    expect(mix.observed).toBe(200);
    expect(mix.shares.engineeringTechnical).toBe(0.5);
    expect(mix.shares.sales).toBe(0.2);
    expect(mix.unclassifiedShare).toBe(0.1);
  });

  it('treats departments the API omits as zero', () => {
    const mix = departmentMix(ACME)!;
    expect(mix.counts.legal).toBe(0);
    expect(mix.shares.medicalHealth).toBe(0);
  });

  it('returns null when nobody is observed', () => {
    expect(departmentMix(workforce('empty.com', [point('2026-10-01', 0, {})]))).toBeNull();
  });
});
