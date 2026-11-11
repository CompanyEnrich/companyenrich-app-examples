/**
 * Server-side validation for every route handler. The browser is untrusted: only
 * known enum values, bounded list sizes, at most 8 x 8 grid cells and at most
 * 10 paid results per request get through to the API.
 */
import { z } from 'zod';
import { MAX_SAMPLE_PAGE_SIZE } from './cost';
import { DIMENSION_LABELS, GRID_DIMENSIONS, MAX_AXIS_VALUES, isValidSegment } from './grid';
import {
  CATEGORIES,
  COMPANY_TYPES,
  EMPLOYEE_RANGES,
  FUNDING_ROUNDS,
  GROWTH_DEPARTMENTS,
  GROWTH_PERIODS,
  REVENUE_RANGES,
} from './options';

const year = z.number().int().min(1800).max(2100);
const yearRange = z.strictObject({ min: year.optional(), max: year.optional() });
const term = z.string().trim().min(1).max(100);
const terms = z.array(term).min(1).max(50);
const termRule = z.union([
  terms,
  z.strictObject({ all: terms.optional(), in: terms.optional(), notIn: terms.optional() }),
]);
const countryCode = z.string().regex(/^[A-Z]{2}$/, 'must be a two-letter uppercase country code');

function enumList<const T extends readonly [string, ...string[]]>(values: T) {
  return z.array(z.enum(values)).min(1).max(values.length);
}

/** The subset of the v2 `CompanySearchFilter` this app builds. Unknown keys are rejected. */
export const companyFilterSchema = z.strictObject({
  country: z.array(countryCode).min(1).max(250).optional(),
  region: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
  state: z.array(z.number().int().positive()).min(1).max(100).optional(),
  city: z.array(z.number().int().positive()).min(1).max(100).optional(),
  naicsCodes: z
    .array(z.string().regex(/^[1-9]\d{1,5}$/, 'must be 2 to 6 digits'))
    .min(1)
    .max(1000)
    .optional(),
  employees: enumList(EMPLOYEE_RANGES).optional(),
  revenue: enumList(REVENUE_RANGES).optional(),
  type: enumList(COMPANY_TYPES).optional(),
  categories: z.union([enumList(CATEGORIES), z.strictObject({ in: enumList(CATEGORIES) })]).optional(),
  technologies: termRule.optional(),
  keywords: termRule.optional(),
  foundedYear: yearRange.optional(),
  fundingRounds: enumList(FUNDING_ROUNDS).optional(),
  fundingYear: yearRange.optional(),
  fundingAmount: z
    .strictObject({ min: z.number().nonnegative().optional(), max: z.number().nonnegative().optional() })
    .optional(),
  workforceGrowth: z
    .strictObject({
      period: z.enum(GROWTH_PERIODS),
      department: z.enum(GROWTH_DEPARTMENTS),
      min: z.number().min(-1).max(100),
    })
    .optional(),
});

export const countRequestSchema = z.strictObject({ filter: companyFilterSchema });
export const previewRequestSchema = countRequestSchema;

export const interpretRequestSchema = z.strictObject({
  query: z.string().trim().min(3, 'describe the market in at least 3 characters').max(300),
});

const axisSchema = z.strictObject({
  dimension: z.enum(GRID_DIMENSIONS),
  values: z.array(z.string()).min(1).max(MAX_AXIS_VALUES),
});

export const gridRequestSchema = z
  .strictObject({ filter: companyFilterSchema, rows: axisSchema, columns: axisSchema })
  .superRefine((input, ctx) => {
    if (input.rows.dimension === input.columns.dimension) {
      ctx.addIssue({ code: 'custom', path: ['columns', 'dimension'], message: 'rows and columns must differ' });
    }
    for (const axis of ['rows', 'columns'] as const) {
      const { dimension, values } = input[axis];
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: 'custom', path: [axis, 'values'], message: 'values must be unique' });
      }
      const invalid = values.find((value) => !isValidSegment(dimension, value));
      if (invalid !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [axis, 'values'],
          message: `"${invalid}" is not a valid ${DIMENSION_LABELS[dimension]} value`,
        });
      }
    }
  });

export const searchRequestSchema = z.strictObject({
  filter: companyFilterSchema,
  pageSize: z.number().int().min(1).max(MAX_SAMPLE_PAGE_SIZE),
  // The browser must say it showed the cost and the user agreed.
  confirm: z.literal(true),
});

export const AUTOCOMPLETE_KINDS = ['technologies', 'keywords', 'countries', 'states', 'cities'] as const;
export type AutocompleteKind = (typeof AUTOCOMPLETE_KINDS)[number];

export const autocompleteRequestSchema = z.strictObject({
  kind: z.enum(AUTOCOMPLETE_KINDS),
  q: z.string().trim().min(1).max(100),
  /** Optional country codes that narrow state and city suggestions. */
  countries: z.array(countryCode).max(250).default([]),
});

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ');
}
