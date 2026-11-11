import { describe, expect, it } from 'vitest';
import { sizeMarket } from '../src/lib/market.js';
import { fakeApi } from './fake-api.js';

const icp = {
  categories: { in: ['saas' as const] },
  employees: ['201-500' as const],
  country: ['US'],
  foundedYear: { min: 2010, max: 2019 },
};

// How many companies each dimension matches on its own.
const SOLO_TOTALS: Record<string, number> = { categories: 900_000, employees: 120_000, country: 7_000_000, foundedYear: 3_000_000 };

describe('sizeMarket', () => {
  it('returns the free count as is when the ICP matches companies', async () => {
    const api = fakeApi({ companyCount: () => ({ count: 200, total: 200 }) });
    const market = await sizeMarket(api.client, icp);
    expect(market).toEqual({ filter: icp, count: 200, total: 200, relaxed: [] });
    expect(api.calls).toHaveLength(1);
  });

  it('drops the most restrictive dimension first, measured by free solo counts, until something matches', async () => {
    // Nothing matches while both employees and foundedYear are in the filter.
    const api = fakeApi({
      companyCount: ({ filter }) => {
        const keys = Object.keys(filter);
        if (keys.length === 1) return { count: 100_000, total: SOLO_TOTALS[keys[0] as string] ?? 0 };
        const empty = keys.includes('employees') && keys.includes('foundedYear');
        return empty ? { count: 0, total: 0 } : { count: 4_200, total: 4_200 };
      },
    });

    const market = await sizeMarket(api.client, icp);

    expect(market.relaxed).toEqual([{ key: 'employees', dimension: 'employees', soloTotal: 120_000, countAfter: 4_200 }]);
    expect(market.filter).toEqual({ categories: icp.categories, country: icp.country, foundedYear: icp.foundedYear });
    expect(market.count).toBe(4_200);
    // 1 full count + 4 solo counts + 1 recount, all on the free endpoint
    expect(api.calls.map((call) => call.path)).toEqual(Array(6).fill('/v2/companies/search/count'));
  });

  it('keeps relaxing in order when one drop is not enough', async () => {
    const api = fakeApi({
      companyCount: ({ filter }) => {
        const keys = Object.keys(filter);
        if (keys.length === 1) return { count: 100_000, total: SOLO_TOTALS[keys[0] as string] ?? 0 };
        return keys.includes('country') && keys.length > 1 ? { count: 0, total: 0 } : { count: 10, total: 10 };
      },
    });
    const market = await sizeMarket(api.client, icp);
    // employees (120k), then categories (900k), then foundedYear (3M) leaves country alone
    expect(market.relaxed.map((step) => step.key)).toEqual(['employees', 'categories', 'foundedYear']);
    expect(market.filter).toEqual({ country: ['US'] });
  });
});
