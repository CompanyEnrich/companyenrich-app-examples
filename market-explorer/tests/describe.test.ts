import { describe, expect, it } from 'vitest';
import { describeInterpretation, describeState, formatUsd, interpretationToState } from '@/lib/describe';
import { emptyFilterState } from '@/lib/filter';

// Captured from a live `companies.count({ semantic })` call.
const INTERPRETATION = {
  filter: { country: { in: ['US'] }, employees: { in: ['51-200' as const] }, foundedYear: { min: 2019 } },
  boost: { categories: ['b2b' as const, 'saas' as const] },
};

describe('describeInterpretation', () => {
  it('turns inferred filters and boosts into readable chips', () => {
    const chips = describeInterpretation(INTERPRETATION);
    expect(chips.filters).toEqual([
      { group: 'Country', text: 'United States' },
      { group: 'Employees', text: '51-200' },
      { group: 'Founded', text: '2019 or later' },
    ]);
    expect(chips.boosts).toEqual([{ group: 'Category', text: 'B2B, SaaS' }]);
    expect(chips.skipped).toEqual([]);
  });

  it('handles an empty interpretation', () => {
    expect(describeInterpretation({})).toEqual({ filters: [], boosts: [], skipped: [] });
    expect(describeInterpretation(null)).toEqual({ filters: [], boosts: [], skipped: [] });
  });
});

describe('interpretationToState', () => {
  it('copies only applied filters by default', () => {
    const { state } = interpretationToState(INTERPRETATION, { includeBoosts: false });
    expect(state.countries.map((c) => c.value)).toEqual(['US']);
    expect(state.categories).toEqual([]);
  });

  it('can turn category boosts into a "match any" category filter', () => {
    const { state } = interpretationToState(INTERPRETATION, { includeBoosts: true });
    expect(state.categories).toEqual(['b2b', 'saas']);
    expect(state.categoryMatch).toBe('any');
  });

  it('notes that company-name boosts are ranking only', () => {
    const { skipped } = interpretationToState({ boost: { names: ['Stripe'] } }, { includeBoosts: true });
    expect(skipped).toContain('company names (ranking only)');
  });
});

describe('describeState', () => {
  it('describes ranges and term lists in plain words', () => {
    const chips = describeState({
      ...emptyFilterState(),
      technologies: { all: ['stripe'], any: [], exclude: ['shopify'] },
      fundingYear: { max: 2020 },
      fundingAmount: { min: 10_000_000, max: 50_000_000 },
      workforceGrowth: { period: 'y1', department: 'engineering_technical', minPercent: 20 },
    });
    expect(chips).toEqual([
      { group: 'Technologies, all of', text: 'stripe' },
      { group: 'Technologies, none of', text: 'shopify' },
      { group: 'Last funding', text: '2020 or earlier' },
      { group: 'Funding amount', text: '$10M to $50M' },
      { group: 'Headcount growth', text: 'Engineering +20% or more, last 12 months' },
    ]);
  });

  it('formats money compactly', () => {
    expect(formatUsd(2_500_000)).toBe('$2.5M');
    expect(formatUsd(1_000_000_000)).toBe('$1B');
  });
});
