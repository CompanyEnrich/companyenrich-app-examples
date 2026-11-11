import { describe, expect, it } from 'vitest';
import { emptyFilterState, toApiFilter } from '@/lib/filter';
import { companyFilterSchema, gridRequestSchema, searchRequestSchema } from '@/lib/schemas';

describe('companyFilterSchema', () => {
  it('accepts everything the builder produces', () => {
    const filter = toApiFilter({
      ...emptyFilterState(),
      countries: [{ value: 'DE', label: 'Germany' }],
      industries: [{ name: 'Software', naicsCodes: ['5112'] }],
      categories: ['b2b', 'saas'],
      categoryMatch: 'any',
      technologies: { all: ['stripe'], any: [], exclude: ['shopify'] },
      fundingAmount: { min: 1_000_000 },
      workforceGrowth: { period: 'y1', department: 'sales', minPercent: 10 },
    });
    expect(companyFilterSchema.safeParse(filter).success).toBe(true);
  });

  it('rejects unknown enum values, unknown fields and malformed codes', () => {
    expect(companyFilterSchema.safeParse({ employees: ['huge'] }).success).toBe(false);
    expect(companyFilterSchema.safeParse({ domain: ['example.com'] }).success).toBe(false);
    expect(companyFilterSchema.safeParse({ country: ['germany'] }).success).toBe(false);
    expect(companyFilterSchema.safeParse({ naicsCodes: ['0123'] }).success).toBe(false);
    expect(companyFilterSchema.safeParse({ technologies: { all: [''] } }).success).toBe(false);
  });
});

describe('gridRequestSchema', () => {
  const axis = (dimension: string, values: string[]) => ({ dimension, values });

  it('accepts an 8 x 8 grid', () => {
    const countries = ['US', 'GB', 'DE', 'FR', 'CA', 'IN', 'NL', 'AU'];
    const employees = ['1-10', '11-50', '51-200', '201-500', '501-1K', '1K-5K', '5K-10K', 'over-10K'];
    expect(
      gridRequestSchema.safeParse({ filter: {}, rows: axis('country', countries), columns: axis('employees', employees) })
        .success,
    ).toBe(true);
  });

  it('rejects more than 8 values, duplicates, bad values and identical dimensions', () => {
    const nine = ['US', 'GB', 'DE', 'FR', 'CA', 'IN', 'NL', 'AU', 'ES'];
    const parse = (rows: unknown, columns: unknown) => gridRequestSchema.safeParse({ filter: {}, rows, columns }).success;
    expect(parse(axis('country', nine), axis('employees', ['1-10']))).toBe(false);
    expect(parse(axis('country', ['US', 'US']), axis('employees', ['1-10']))).toBe(false);
    expect(parse(axis('country', ['usa']), axis('employees', ['1-10']))).toBe(false);
    expect(parse(axis('revenue', ['under-1m']), axis('revenue', ['over-1b']))).toBe(false);
    expect(parse(axis('industry', ['x']), axis('revenue', ['over-1b']))).toBe(false);
  });
});

describe('searchRequestSchema', () => {
  it('requires an explicit confirm and caps the page size at 10', () => {
    expect(searchRequestSchema.safeParse({ filter: {}, pageSize: 10, confirm: true }).success).toBe(true);
    expect(searchRequestSchema.safeParse({ filter: {}, pageSize: 11, confirm: true }).success).toBe(false);
    expect(searchRequestSchema.safeParse({ filter: {}, pageSize: 3 }).success).toBe(false);
    expect(searchRequestSchema.safeParse({ filter: {}, pageSize: 3, confirm: true, cursor: 'next' }).success).toBe(false);
  });
});
