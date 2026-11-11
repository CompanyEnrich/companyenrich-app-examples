import { describe, expect, it } from 'vitest';
import { comparableRate, computeGrowth, growthBetween, pointAt } from '@/lib/growth';
import { ACME, DELTA, point, workforce } from './fixtures';

describe('pointAt', () => {
  const history = [point('2026-06-01', 12, {}), point('2026-01-01', 10, {}), point('2025-12-01', 9, {})];

  it('carries the last change point forward through months without one', () => {
    expect(pointAt(history, '2026-04-01')?.observedEmployeeCount).toBe(10);
    expect(pointAt(history, '2026-06-01')?.observedEmployeeCount).toBe(12);
  });

  it('returns nothing before the first point', () => {
    expect(pointAt(history, '2025-11-01')).toBeUndefined();
  });

  it('does not depend on the order of the history', () => {
    expect(pointAt([...history].reverse(), '2026-04-01')?.observedEmployeeCount).toBe(10);
  });
});

describe('growthBetween', () => {
  it('measures growth from a big enough baseline', () => {
    expect(growthBetween(80, 100)).toEqual({ kind: 'measured', from: 80, to: 100, rate: 0.25 });
  });

  it('flags small baselines instead of comparing them', () => {
    expect(growthBetween(2, 6)).toEqual({ kind: 'small-base', from: 2, to: 6, rate: 2 });
  });

  it('has no rate for a zero baseline', () => {
    expect(growthBetween(0, 7)).toEqual({ kind: 'zero-base', from: 0, to: 7 });
  });
});

describe('computeGrowth', () => {
  it('compares the window start with the newest snapshot, overall and per department', () => {
    const growth = computeGrowth(ACME);
    expect(growth.window).toEqual({ start: '2025-12-01', end: '2026-10-01' });
    expect(growth.overall).toEqual({ kind: 'measured', from: 160, to: 200, rate: 0.25 });
    expect(growth.departments.engineeringTechnical).toMatchObject({ kind: 'measured', rate: 0.25 });
    expect(growth.departments.sales).toMatchObject({ kind: 'measured', rate: 0 });
    expect(growth.departments.productManagement).toMatchObject({ kind: 'small-base', from: 4, to: 10 });
    expect(growth.departments.legal).toEqual({ kind: 'zero-base', from: 0, to: 0 });
  });

  it('fills a window start that falls between change points', () => {
    const sparse = workforce('sparse.com', [point('2026-05-01', 30, { sales: 10 }), point('2025-10-01', 20, { sales: 5 })]);
    expect(computeGrowth(sparse).overall).toEqual({ kind: 'measured', from: 20, to: 30, rate: 0.5 });
  });

  it('reports companies without history', () => {
    const growth = computeGrowth(DELTA);
    expect(growth.window).toBeNull();
    expect(growth.overall).toEqual({ kind: 'no-history', firstDate: null });
    expect(growth.departments.sales).toEqual({ kind: 'no-history', firstDate: null });
  });

  it('reports history that starts after the window start', () => {
    const late = workforce('late.com', [point('2026-08-01', 40, {}), point('2026-03-01', 30, {})]);
    expect(computeGrowth(late).overall).toEqual({ kind: 'no-history', firstDate: '2026-03-01' });
  });

  it('treats a null history like an empty one', () => {
    expect(computeGrowth({ ...ACME, history: null }).overall.kind).toBe('no-history');
  });
});

describe('comparableRate', () => {
  it('only returns measured rates', () => {
    expect(comparableRate(growthBetween(10, 12))).toBeCloseTo(0.2);
    expect(comparableRate(growthBetween(2, 6))).toBeNull();
    expect(comparableRate(null)).toBeNull();
  });
});
