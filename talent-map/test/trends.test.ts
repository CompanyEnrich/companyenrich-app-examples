import type { CompanyWorkforce } from '@companyenrich/sdk';
import { describe, expect, it } from 'vitest';
import { describeTrend, teamTrend } from '../src/lib/trends.js';
import { makeWorkforce } from './fake-api.js';

describe('teamTrend', () => {
  it('compares today with the oldest history point (history is newest first)', () => {
    const trend = teamTrend(makeWorkforce('co', 120, 100), ['engineeringTechnical']);
    expect(trend).toEqual({ headcount: 120, baseline: { headcount: 100, date: '2025-12-01' }, change: 20, changePct: 0.2, direction: 'up' });
  });

  it('sums several departments and treats a missing department as 0', () => {
    const trend = teamTrend(makeWorkforce('co', 30, 40), ['engineeringTechnical', 'sales', 'design']);
    expect(trend).toMatchObject({ headcount: 40, baseline: { headcount: 50 }, change: -10, direction: 'down' });
  });

  it('uses the whole company when there is no department', () => {
    expect(teamTrend(makeWorkforce('co', 10, 5), [])).toMatchObject({ headcount: 30, baseline: { headcount: 15 }, direction: 'up' });
  });

  it('calls small changes flat', () => {
    expect(teamTrend(makeWorkforce('co', 102, 100), ['engineeringTechnical']).direction).toBe('flat');
    expect(teamTrend(makeWorkforce('co', 100, 100), ['engineeringTechnical'])).toMatchObject({ change: 0, direction: 'flat' });
  });

  it('omits the percentage when the team started from zero', () => {
    const trend = teamTrend(makeWorkforce('co', 3, 0), ['engineeringTechnical']);
    expect(trend.changePct).toBeUndefined();
    expect(trend.direction).toBe('up');
  });

  it('returns only the headcount when there is no history', () => {
    const workforce: CompanyWorkforce = { ...makeWorkforce('co', 8, 8), history: [] };
    expect(teamTrend(workforce, ['engineeringTechnical'])).toEqual({ headcount: 8 });
  });
});

describe('describeTrend', () => {
  it('formats the change with an arrow, sign, percentage and baseline month', () => {
    expect(describeTrend(teamTrend(makeWorkforce('co', 120, 100), ['engineeringTechnical']))).toEqual({
      arrow: '▲',
      change: '+20 (+20%)',
      since: 'since Dec 2025: 100 → 120',
    });
    expect(describeTrend(teamTrend(makeWorkforce('co', 40, 50), ['engineeringTechnical']))?.change).toBe('−10 (−20%)');
    expect(describeTrend({ headcount: 5 })).toBeUndefined();
  });
});
