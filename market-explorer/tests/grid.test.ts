import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '@/lib/concurrency';
import { emptyFilterState, toApiFilter } from '@/lib/filter';
import {
  GRID_DIMENSIONS,
  applySegment,
  applySegmentToState,
  buildGridCells,
  computeGrid,
  defaultAxisValues,
  dimensionOptions,
  segmentLabel,
  sortSegments,
} from '@/lib/grid';
import type { CompanyFilter } from '@/lib/options';

const BASE: CompanyFilter = { categories: ['saas'], employees: ['51-200', '201-500'] };

describe('applySegment', () => {
  it('replaces the field the segment belongs to and keeps the rest', () => {
    expect(applySegment(BASE, 'employees', '11-50')).toEqual({ categories: ['saas'], employees: ['11-50'] });
    expect(applySegment(BASE, 'country', 'DE')).toEqual({ ...BASE, country: ['DE'] });
    expect(applySegment(BASE, 'foundedYear', '2015-2019')).toEqual({ ...BASE, foundedYear: { min: 2015, max: 2019 } });
    expect(applySegment(BASE, 'foundedYear', 'before-1990')).toEqual({ ...BASE, foundedYear: { max: 1989 } });
  });

  it('does not mutate the base filter', () => {
    const base = { ...BASE };
    applySegment(base, 'employees', '1-10');
    expect(base).toEqual(BASE);
  });

  it('matches the builder-state version, so clicking a cell reproduces its count', () => {
    const state = { ...emptyFilterState(), categories: ['saas' as const], countries: [{ value: 'US', label: 'United States' }] };
    for (const dimension of GRID_DIMENSIONS) {
      const value = dimension === 'country' ? 'DE' : (dimensionOptions(dimension)[1]?.value ?? '');
      expect(toApiFilter(applySegmentToState(state, dimension, value))).toEqual(
        applySegment(toApiFilter(state), dimension, value),
      );
    }
  });
});

describe('buildGridCells', () => {
  it('creates one filter per cell', () => {
    const cells = buildGridCells(
      BASE,
      { dimension: 'country', values: ['US', 'DE'] },
      { dimension: 'revenue', values: ['1m-10m', '10m-50m', '50m-100m'] },
    );
    expect(cells).toHaveLength(6);
    expect(cells[0]).toEqual({ row: 'US', column: '1m-10m', filter: { ...BASE, country: ['US'], revenue: ['1m-10m'] } });
  });

  it('rejects oversized axes, unknown values and identical dimensions', () => {
    const nine = ['US', 'GB', 'DE', 'FR', 'CA', 'IN', 'NL', 'AU', 'ES'];
    expect(() => buildGridCells(BASE, { dimension: 'country', values: nine }, { dimension: 'employees', values: ['1-10'] })).toThrow(
      /1 to 8/,
    );
    expect(() => buildGridCells(BASE, { dimension: 'employees', values: ['huge'] }, { dimension: 'country', values: ['US'] })).toThrow(
      /not a valid/,
    );
    expect(() => buildGridCells(BASE, { dimension: 'country', values: ['US'] }, { dimension: 'country', values: ['DE'] })).toThrow(
      /different/,
    );
  });
});

describe('defaultAxisValues', () => {
  it('starts from what the filter already selects', () => {
    expect(defaultAxisValues('employees', BASE)).toEqual(['51-200', '201-500']);
    expect(defaultAxisValues('categories', { categories: { in: ['b2b', 'saas'] } })).toEqual(['b2b', 'saas']);
    expect(defaultAxisValues('country', { country: ['FR'] })).toEqual(['FR']);
  });

  it('falls back to the first 8 options', () => {
    expect(defaultAxisValues('fundingRounds', {})).toHaveLength(8);
    expect(defaultAxisValues('country', {})).toHaveLength(8);
    expect(defaultAxisValues('foundedYear', {})).toEqual(dimensionOptions('foundedYear').map((o) => o.value));
  });
});

describe('computeGrid', () => {
  it('counts every cell with at most 4 requests in flight and labels the axes', async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await computeGrid(
      {},
      { dimension: 'country', values: ['US', 'DE', 'FR', 'GB'] },
      { dimension: 'employees', values: ['1-10', '11-50', '51-200', '201-500'] },
      async (filter) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight--;
        const n = (filter.country as string[])[0] === 'US' ? 100 : 10;
        return { count: n, total: n };
      },
    );
    expect(result.requests).toBe(16);
    expect(result.cells).toHaveLength(16);
    expect(peak).toBeLessThanOrEqual(4);
    expect(result.rows.map((r) => r.label)).toEqual(['United States', 'Germany', 'France', 'United Kingdom']);
    expect(result.cells.find((c) => c.row === 'US')?.count).toBe(100);
  });

  it('reports a failed cell without failing the grid', async () => {
    const result = await computeGrid(
      {},
      { dimension: 'revenue', values: ['under-1m', 'over-1b'] },
      { dimension: 'categories', values: ['saas'] },
      async (filter) => {
        if ((filter.revenue as string[])[0] === 'over-1b') throw new Error('boom');
        return { count: 5, total: 5 };
      },
    );
    expect(result.cells).toEqual([
      { row: 'under-1m', column: 'saas', count: 5, total: 5 },
      { row: 'over-1b', column: 'saas', count: null, total: null, error: 'boom' },
    ]);
  });
});

describe('labels and concurrency helper', () => {
  it('labels segments in plain words', () => {
    expect(segmentLabel('fundingRounds', 'series_a')).toBe('Series A');
    expect(segmentLabel('revenue', 'over-1b')).toBe('> $1B');
  });

  it('sorts fixed choices into their natural order', () => {
    expect(sortSegments('employees', ['501-1K', '11-50', '51-200'])).toEqual(['11-50', '51-200', '501-1K']);
    expect(sortSegments('country', ['US', 'DE'])).toEqual(['US', 'DE']);
  });

  it('keeps results in input order', async () => {
    const out = await mapWithConcurrency([30, 10, 20], 2, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });
});
