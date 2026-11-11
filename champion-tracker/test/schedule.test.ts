import { describe, expect, it } from 'vitest';
import { dueChampions, isDue } from '../src/lib/schedule.js';

describe('isDue', () => {
  const now = new Date('2026-11-11T08:00:00Z');

  it('is not due before the interval has passed', () => {
    expect(isDue('2026-11-01T08:00:00Z', now, 30)).toBe(false);
  });

  it('is due once the interval has passed', () => {
    expect(isDue('2026-10-01T08:00:00Z', now, 30)).toBe(true);
  });

  it('allows a 10% grace window so a monthly job does not skip February', () => {
    // 1 February to 1 March is only 28 days.
    expect(isDue('2027-02-01T08:30:00Z', new Date('2027-03-01T08:05:00Z'), 30)).toBe(true);
    expect(isDue('2026-10-20T08:00:00Z', now, 30)).toBe(false);
  });

  it('treats 0 days as always due', () => {
    expect(isDue(now.toISOString(), now, 0)).toBe(true);
  });

  it('treats an unreadable date as due', () => {
    expect(isDue('not a date', now, 30)).toBe(true);
  });
});

describe('dueChampions', () => {
  it('returns due champions, longest-waiting first', () => {
    const champions = [
      { id: 'recent', lastCheckedAt: '2026-11-05T00:00:00Z' },
      { id: 'newer', lastCheckedAt: '2026-09-15T00:00:00Z' },
      { id: 'oldest', lastCheckedAt: '2026-08-01T00:00:00Z' },
    ];
    expect(dueChampions(champions, new Date('2026-11-11T00:00:00Z'), 30).map((champion) => champion.id)).toEqual(['oldest', 'newer']);
  });
});
