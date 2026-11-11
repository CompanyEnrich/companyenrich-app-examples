import { describe, expect, it } from 'vitest';
import { emptyFilterState, fromApiFilter, toApiFilter, type FilterState } from '@/lib/filter';

function state(patch: Partial<FilterState>): FilterState {
  return { ...emptyFilterState(), ...patch };
}

describe('toApiFilter', () => {
  it('sends an empty filter when nothing is set', () => {
    expect(toApiFilter(emptyFilterState())).toEqual({});
  });

  it('maps every control to its v2 field', () => {
    const filter = toApiFilter(
      state({
        countries: [{ value: 'DE', label: 'Germany' }],
        regions: [{ value: 'Europe/Western Europe', label: 'Western Europe' }],
        states: [{ value: 4845, label: 'California' }],
        cities: [{ value: 37140, label: 'Berlin' }],
        employees: ['51-200', '201-500'],
        revenue: ['10m-50m'],
        types: ['private'],
        categories: ['saas'],
        foundedYear: { min: 2015 },
        fundingRounds: ['series_a'],
        fundingYear: { min: 2024, max: 2026 },
        fundingAmount: { min: 10_000_000 },
        workforceGrowth: { period: 'y1', department: 'engineering_technical', minPercent: 20 },
      }),
    );
    expect(filter).toEqual({
      country: ['DE'],
      region: ['Europe/Western Europe'],
      state: [4845],
      city: [37140],
      employees: ['51-200', '201-500'],
      revenue: ['10m-50m'],
      type: ['private'],
      categories: ['saas'],
      foundedYear: { min: 2015 },
      fundingRounds: ['series_a'],
      fundingYear: { min: 2024, max: 2026 },
      fundingAmount: { min: 10_000_000 },
      workforceGrowth: { period: 'y1', department: 'engineering_technical', min: 0.2 },
    });
  });

  it('maps industries to the union of their NAICS codes', () => {
    const filter = toApiFilter(
      state({
        industries: [
          { name: 'Business Services/Accounting Services', naicsCodes: ['5412'] },
          { name: 'Software', naicsCodes: ['5112', '5412'] },
        ],
      }),
    );
    expect(filter).toEqual({ naicsCodes: ['5412', '5112'] });
  });

  it('uses a plain array for "match all" categories and `in` for "match any"', () => {
    expect(toApiFilter(state({ categories: ['b2b', 'saas'] })).categories).toEqual(['b2b', 'saas']);
    expect(toApiFilter(state({ categories: ['b2b', 'saas'], categoryMatch: 'any' })).categories).toEqual({
      in: ['b2b', 'saas'],
    });
    // One category means the same thing either way, so keep the simple form.
    expect(toApiFilter(state({ categories: ['saas'], categoryMatch: 'any' })).categories).toEqual(['saas']);
  });

  it('maps technology lists to {all, in, notIn}', () => {
    expect(toApiFilter(state({ technologies: { all: ['stripe'], any: [], exclude: [] } })).technologies).toEqual(['stripe']);
    expect(
      toApiFilter(state({ technologies: { all: ['stripe', 'react'], any: ['hubspot'], exclude: ['shopify'] } })).technologies,
    ).toEqual({ all: ['stripe', 'react'], in: ['hubspot'], notIn: ['shopify'] });
    expect(toApiFilter(state({ keywords: { all: [], any: [], exclude: ['crypto'] } })).keywords).toEqual({ notIn: ['crypto'] });
  });

  it('converts growth percent to the ratio the API expects', () => {
    const filter = toApiFilter(state({ workforceGrowth: { period: 'm6', department: 'sales', minPercent: 15 } }));
    expect(filter.workforceGrowth).toEqual({ period: 'm6', department: 'sales', min: 0.15 });
  });
});

describe('fromApiFilter', () => {
  it('reads an interpretation in the advanced {in} form', () => {
    const { state: imported, skipped } = fromApiFilter({
      country: { in: ['DE'] },
      fundingRounds: { in: ['series_a'] },
      employees: { in: ['51-200'] },
      foundedYear: { min: 2019 },
    });
    expect(imported.countries).toEqual([{ value: 'DE', label: 'Germany' }]);
    expect(imported.fundingRounds).toEqual(['series_a']);
    expect(imported.employees).toEqual(['51-200']);
    expect(imported.foundedYear).toEqual({ min: 2019 });
    expect(skipped).toEqual([]);
  });

  it('labels states and cities by id, because the API returns ids only', () => {
    const { state: imported } = fromApiFilter({ state: { in: [4845] }, city: [37140] });
    expect(imported.states).toEqual([{ value: 4845, label: 'State #4845' }]);
    expect(imported.cities).toEqual([{ value: 37140, label: 'City #37140' }]);
  });

  it('accepts single values, arrays and objects', () => {
    expect(fromApiFilter({ country: 'us' }).state.countries[0]?.value).toBe('US');
    expect(fromApiFilter({ technologies: 'stripe' }).state.technologies).toEqual({ all: ['stripe'], any: [], exclude: [] });
    expect(fromApiFilter({ technologies: { all: ['a'], in: ['b'], notIn: ['c'] } }).state.technologies).toEqual({
      all: ['a'],
      any: ['b'],
      exclude: ['c'],
    });
    expect(fromApiFilter({ categories: { in: ['b2b', 'saas'] } }).state).toMatchObject({
      categories: ['b2b', 'saas'],
      categoryMatch: 'any',
    });
  });

  it('reports what the builder cannot represent instead of dropping it silently', () => {
    const { skipped } = fromApiFilter({
      domain: ['example.com'],
      employees: { notIn: ['1-10'] },
      require: ['linkedin'],
    });
    expect(skipped).toEqual(['employees exclusions', 'domain', 'require']);
  });

  it('round-trips everything the builder produces', () => {
    const original = state({
      countries: [{ value: 'FR', label: 'France' }],
      employees: ['11-50'],
      categories: ['b2b', 'saas'],
      categoryMatch: 'any',
      technologies: { all: ['stripe'], any: ['react'], exclude: ['shopify'] },
      keywords: { all: ['fintech'], any: [], exclude: [] },
      foundedYear: { min: 2010, max: 2020 },
      fundingAmount: { min: 5_000_000 },
      workforceGrowth: { period: 'y2', department: 'overall', minPercent: 25 },
    });
    const filter = toApiFilter(original);
    expect(toApiFilter(fromApiFilter(filter).state)).toEqual(filter);
  });
});
