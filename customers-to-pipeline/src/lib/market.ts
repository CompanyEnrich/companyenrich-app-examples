import { MAX_CONCURRENCY, mapLimit } from './concurrency.js';
import { dimensionLabel } from './icp.js';
import type { CompanyEnrich, CompanySearchFilter } from './types.js';

export interface Relaxation {
  /** The filter key that was dropped. */
  key: string;
  dimension: string;
  /** Companies matching this dimension on its own: lower means more restrictive. */
  soloTotal: number;
  /** The ICP count after dropping it. */
  countAfter: number;
}

export interface MarketSize {
  /** The ICP minus any relaxed dimensions: the filter later steps search with. */
  filter: CompanySearchFilter;
  /** Matching companies your plan can access. */
  count: number;
  /** Matching companies before plan limits. */
  total: number;
  relaxed: Relaxation[];
}

/**
 * Sizes the ICP market with free counts. If nothing matches, drops one dimension at a time, most
 * restrictive first, until the count is non-zero. Restrictiveness is the free count of each dimension
 * on its own, using `total` because `count` is capped by the plan and would tie.
 */
export async function sizeMarket(client: CompanyEnrich, icp: CompanySearchFilter): Promise<MarketSize> {
  let filter: CompanySearchFilter = { ...icp };
  let { count, total } = await client.companies.count({ filter });
  const relaxed: Relaxation[] = [];
  if (count > 0) return { filter, count, total, relaxed };

  const keys = (Object.keys(filter) as (keyof CompanySearchFilter)[]).filter((key) => key !== 'domain');
  const soloTotals = await mapLimit(keys, MAX_CONCURRENCY, async (key) => {
    const solo = await client.companies.count({ filter: { [key]: filter[key] } });
    return solo.total;
  });
  // Array.prototype.sort is stable, so ties keep the filter's key order.
  const order = keys.map((key, index) => ({ key, soloTotal: soloTotals[index] ?? 0 })).sort((a, b) => a.soloTotal - b.soloTotal);

  for (const { key, soloTotal } of order) {
    filter = { ...filter };
    delete filter[key];
    ({ count, total } = await client.companies.count({ filter }));
    relaxed.push({ key, dimension: dimensionLabel(key), soloTotal, countAfter: count });
    if (count > 0) break;
  }
  return { filter, count, total, relaxed };
}
