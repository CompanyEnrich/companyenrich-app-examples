import { describe, expect, it } from 'vitest';
import { buildBenchmark } from '@/lib/benchmark';
import { buildInsights } from '@/lib/insights';
import { BETA, groupOutcomes, point, workforce } from './fixtures';

describe('buildInsights', () => {
  it('writes the same sentences, in the same order, for the same data', () => {
    expect(buildInsights(buildBenchmark(groupOutcomes()))).toEqual([
      'Acme has 200 observed employees, more than 2 of 3 peers (peer median 100).',
      'Observed headcount at Acme grew 25% since Dec 2025 (160 → 200) vs a peer median of +3%.',
      "Acme's engineering team is 1.7× the peer median share (50% of observed headcount vs 30%), the highest in the group.",
      "Acme's sales team is 2.0× the peer median share (20% of observed headcount vs 10%), the highest in the group.",
      "Acme's marketing team is 0.5× the peer median share (5.0% of observed headcount vs 10%), the lowest in the group.",
      "Acme's engineering team grew 25% since Dec 2025 (80 → 100) vs a peer median of +3%.",
      "Acme's operations team held flat since Dec 2025 (20 → 20) vs a peer median of +10%.",
      'Excluded from the peer group: epsilon.ai (no workforce data for this domain).',
    ]);
  });

  it('says plainly when the subject has no data', () => {
    const outcomes = groupOutcomes();
    outcomes[0] = { domain: 'acme.com', name: 'acme.com', role: 'subject', status: 'excluded', reason: 'no workforce data for this domain' };
    expect(buildInsights(buildBenchmark(outcomes))[0]).toBe(
      'There is no workforce data for acme.com, so there is nothing to compare. Try another domain for the same company.',
    );
  });

  it('says plainly when no peer has data', () => {
    const outcomes = groupOutcomes().filter((outcome) => outcome.role === 'subject');
    expect(buildInsights(buildBenchmark(outcomes))).toEqual([
      'None of the peers has workforce data, so Acme cannot be compared. Pick different peers.',
    ]);
  });

  it('explains why growth is not compared', () => {
    const outcomes = groupOutcomes();
    const late = workforce('acme.com', [point('2026-10-01', 200, { sales: 40 }), point('2026-04-01', 150, { sales: 30 })]);
    outcomes[0] = { domain: 'acme.com', name: 'Acme', role: 'subject', status: 'ok', workforce: late };
    expect(buildInsights(buildBenchmark(outcomes))).toContain(
      'Growth for Acme is not compared because its history only starts in Apr 2026.',
    );
  });

  it('handles departments the peers do not have, and teams the subject lacks', () => {
    const subject = workforce('acme.com', [point('2025-12-01', 100, { engineeringTechnical: 50, legal: 10 }, 40)]);
    const outcomes = [
      { domain: 'acme.com', name: 'Acme', role: 'subject' as const, status: 'ok' as const, workforce: subject },
      { domain: 'beta.io', name: 'Beta', role: 'peer' as const, status: 'ok' as const, workforce: BETA },
    ];
    const insights = buildInsights(buildBenchmark(outcomes));
    expect(insights).toContain("Acme's legal team is 10% of observed headcount, while the peer median is 0%.");
    expect(insights).toContain('Acme has no observed marketing team, while the peer median share is 15%.');
    expect(insights).toContain(
      "40% of Acme's observed headcount has no department from job titles (peer median 10%), so its department shares read lower than the peers'.",
    );
  });

  it('ranks department growth by how many people the gap represents', () => {
    const start = '2025-12-01';
    const end = '2026-10-01';
    const subject = workforce('acme.com', [
      point(end, 140, { engineeringTechnical: 120, marketing: 10 }),
      point(start, 110, { engineeringTechnical: 100, marketing: 5 }),
    ]);
    const peer = (domain: string) =>
      workforce(domain, [point(end, 110, { engineeringTechnical: 100, marketing: 10 }), point(start, 110, { engineeringTechnical: 100, marketing: 10 })]);
    const outcomes = [
      { domain: 'acme.com', name: 'Acme', role: 'subject' as const, status: 'ok' as const, workforce: subject },
      { domain: 'beta.io', name: 'Beta', role: 'peer' as const, status: 'ok' as const, workforce: peer('beta.io') },
      { domain: 'gamma.com', name: 'Gamma', role: 'peer' as const, status: 'ok' as const, workforce: peer('gamma.com') },
    ];
    const growth = buildInsights(buildBenchmark(outcomes)).filter((text) => text.includes('team grew'));
    // +20% on 100 engineers (20 extra people) outranks +100% on 5 marketers (5 extra people).
    expect(growth).toEqual([
      "Acme's engineering team grew 20% since Dec 2025 (100 → 120) vs a peer median of 0%.",
      "Acme's marketing team grew 100% since Dec 2025 (5 → 10) vs a peer median of 0%.",
    ]);
  });
});
