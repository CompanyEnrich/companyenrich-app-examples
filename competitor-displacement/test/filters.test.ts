import { describe, expect, it } from 'vitest';
import { buildTargetFilter, excludeDomains, technologyRule } from '../src/lib/filters.js';
import { sizeMarket } from '../src/lib/sizing.js';
import { fakeApi } from './fake-api.js';

describe('filter construction', () => {
  it('requires the competitor with `all` and excludes your technology with `notIn`', () => {
    expect(technologyRule('zendesk', 'intercom')).toEqual({ all: ['zendesk'], notIn: ['intercom'] });
  });

  it('leaves out `notIn` when --mine is not given', () => {
    expect(technologyRule('zendesk')).toEqual({ all: ['zendesk'] });
    expect(buildTargetFilter({ competitor: 'zendesk', countries: [], employees: [], categories: [], exclude: [] })).toEqual({
      technologies: { all: ['zendesk'] },
    });
  });

  it('adds firmographic filters only when given, with categories matching any of the list', () => {
    const filter = buildTargetFilter({
      competitor: 'zendesk',
      mine: 'intercom',
      countries: ['US', 'GB'],
      employees: ['51-200', '201-500'],
      categories: ['saas', 'b2b'],
      exclude: [],
    });
    expect(filter).toEqual({
      technologies: { all: ['zendesk'], notIn: ['intercom'] },
      country: ['US', 'GB'],
      employees: ['51-200', '201-500'],
      categories: { in: ['saas', 'b2b'] },
    });
  });

  it('excludes already-fetched domains with `domain.notIn`, and adds nothing for an empty list', () => {
    const base = { technologies: { all: ['zendesk'] } };
    expect(excludeDomains(base, [])).toBe(base);
    expect(excludeDomains(base, ['a.example', 'b.example'])).toEqual({ ...base, domain: { notIn: ['a.example', 'b.example'] } });
  });
});

describe('sizeMarket', () => {
  it('counts installs, overlap, targets and both breakdowns, using only free counts', async () => {
    const api = fakeApi();
    const market = await sizeMarket(api.client, { competitor: 'zendesk', mine: 'intercom', countries: [], employees: [], categories: [], exclude: [] });

    expect(market.competitorInstalls).toBe(8);
    expect(market.overlap).toBe(1);
    expect(market.targets).toBe(7);
    expect(market.byCountry.find((row) => row.label === 'US')?.companies).toBe(5);
    expect(market.byCountry.at(-1)).toEqual({ label: 'Other or unknown', companies: 0 }); // GB and DE are in the default list
    expect(market.byEmployees.filter((row) => row.companies > 0)).toEqual([
      { label: '51-200', companies: 6 },
      { label: '201-500', companies: 1 },
    ]);
    expect(api.paidCalls()).toHaveLength(0);
  });

  it('breaks down only the requested countries and ranges, without a remainder row', async () => {
    const api = fakeApi();
    const market = await sizeMarket(api.client, { competitor: 'zendesk', countries: ['US'], employees: ['51-200'], categories: [], exclude: [] });
    expect(market.overlap).toBeUndefined();
    expect(market.byCountry).toEqual([{ label: 'US', companies: 5 }]); // includes hotel: no --mine to exclude it
    expect(market.byEmployees).toEqual([{ label: '51-200', companies: 5 }]);
  });
});
