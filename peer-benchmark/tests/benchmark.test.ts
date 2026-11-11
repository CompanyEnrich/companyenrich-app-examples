import { describe, expect, it } from 'vitest';
import { buildBenchmark, departmentsForGrowth, departmentsForMix } from '@/lib/benchmark';
import { ACME, groupOutcomes, point, workforce } from './fixtures';

const byKey = (benchmark: ReturnType<typeof buildBenchmark>, key: string) =>
  benchmark.departments.find((department) => department.key === key)!;

describe('buildBenchmark', () => {
  const benchmark = buildBenchmark(groupOutcomes());

  it('splits the subject, usable peers and excluded companies', () => {
    expect(benchmark.subject?.domain).toBe('acme.com');
    expect(benchmark.peers.map((peer) => peer.domain)).toEqual(['beta.io', 'gamma.com', 'delta.dev']);
    expect(benchmark.excluded).toEqual([
      { domain: 'epsilon.ai', name: 'Epsilon', role: 'peer', reason: 'no workforce data for this domain' },
    ]);
  });

  it('compares department shares with the peer median', () => {
    const sales = byKey(benchmark, 'sales');
    expect(sales.share.subject).toBe(0.2);
    expect(sales.share.peerMedian).toBe(0.1);
    expect(sales.share.ratio).toBe(2);
    expect(sales.share.rank).toMatchObject({ below: 3, total: 3, percentile: 100 });
    expect(sales.share.peers.map((peer) => peer.name)).toEqual(['Beta', 'Gamma', 'Delta']);
  });

  it('leaves the ratio empty when the peer median is zero', () => {
    expect(byKey(benchmark, 'legal').share.ratio).toBeNull();
  });

  it('compares growth only for companies with a measured baseline', () => {
    expect(benchmark.growth.subject).toBe(0.25);
    // Delta has no history, so only Beta (0%) and Gamma (+5.3%) count.
    expect(benchmark.growth.peers.map((peer) => peer.domain)).toEqual(['beta.io', 'gamma.com']);
    expect(benchmark.growth.peerMedian).toBeCloseTo(0.0263, 4);
    // Acme's product team started at 4 people: shown, not compared.
    expect(byKey(benchmark, 'productManagement').growth.subject).toBeNull();
    expect(byKey(benchmark, 'productManagement').growth.subjectGrowth?.kind).toBe('small-base');
  });

  it('uses the shared 12-month window, ending at the newest snapshot in the group', () => {
    expect(benchmark.window).toEqual({ start: '2025-12-01', end: '2026-10-01' });
    const outcomes = groupOutcomes();
    outcomes[1] = { ...outcomes[1]!, status: 'ok', workforce: workforce('beta.io', [point('2026-11-01', 100, {}), point('2025-12-01', 90, {})]) };
    expect(buildBenchmark(outcomes).window).toEqual({ start: '2025-12-01', end: '2026-11-01' });
  });

  it('measures every company over the same window when their responses come from different months', () => {
    // Cached on 31 October: its window starts in November 2025 and it tripled since then...
    const cached = { ...workforce('acme.com', [point('2026-10-01', 30, {}), point('2025-12-01', 20, {}), point('2025-11-01', 10, {})]), historyFrom: '2025-11-01' };
    // ...fetched on 1 November: its window starts in December 2025.
    const fresh = workforce('beta.io', [point('2026-11-01', 30, {}), point('2025-12-01', 10, {})]);
    const result = buildBenchmark([
      { domain: 'acme.com', name: 'Acme', role: 'subject', status: 'ok', workforce: cached },
      { domain: 'beta.io', name: 'Beta', role: 'peer', status: 'ok', workforce: fresh },
    ]);
    // Over its own window Acme would show +200% like Beta; from the shared December start it is +50%.
    expect(result.growth.subject).toBe(0.5);
    expect(result.growth.peerMedian).toBe(2);
    expect(result.window).toEqual({ start: '2025-12-01', end: '2026-11-01' });
  });

  it('does not compare a company with no snapshot at the common window start', () => {
    const late = workforce('beta.io', [point('2026-11-01', 30, {}), point('2026-02-01', 10, {})]);
    const result = buildBenchmark([
      { domain: 'acme.com', name: 'Acme', role: 'subject', status: 'ok', workforce: ACME },
      { domain: 'beta.io', name: 'Beta', role: 'peer', status: 'ok', workforce: late },
    ]);
    expect(result.peers[0]?.growth.overall).toEqual({ kind: 'no-history', firstDate: '2026-02-01' });
    expect(result.growth.peers).toEqual([]);
  });

  it('excludes a company with no observed employees instead of dividing by zero', () => {
    const outcomes = groupOutcomes();
    outcomes[1] = { ...outcomes[1]!, status: 'ok', workforce: workforce('beta.io', [point('2026-10-01', 0, {})]) };
    const result = buildBenchmark(outcomes);
    expect(result.excluded.map((company) => company.domain)).toContain('beta.io');
    expect(result.peers).toHaveLength(2);
  });

  it('copes with a subject that has no data', () => {
    const outcomes = groupOutcomes();
    outcomes[0] = { domain: 'acme.com', name: 'Acme', role: 'subject', status: 'excluded', reason: 'no workforce data for this domain' };
    const result = buildBenchmark(outcomes);
    expect(result.subject).toBeNull();
    expect(byKey(result, 'sales').share.subject).toBeNull();
    expect(byKey(result, 'sales').share.peerMedian).toBe(0.1);
  });
});

describe('chart rows', () => {
  const benchmark = buildBenchmark(groupOutcomes());

  it('hides departments under 1% everywhere and sorts by peer median, then the subject share', () => {
    // Sales, operations and marketing tie at a 10% peer median; Acme's own shares order them.
    expect(departmentsForMix(benchmark).map((department) => department.key)).toEqual([
      'engineeringTechnical',
      'sales',
      'operations',
      'marketing',
      'productManagement',
    ]);
  });

  it('keeps growth rows that have at least one comparable rate', () => {
    expect(departmentsForGrowth(benchmark).map((department) => department.key)).toEqual([
      'engineeringTechnical',
      'sales',
      'operations',
      'marketing',
      'productManagement',
    ]);
  });
});
