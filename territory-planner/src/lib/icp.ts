import { readFile } from 'node:fs/promises';
import type { CompanySearchQuery } from '@companyenrich/sdk';
import { UsageError } from './errors.js';

/** A v2 company search filter, as accepted by `companies.count` and `companies.search`. */
export type CompanyFilter = NonNullable<CompanySearchQuery['filter']>;

type EnumOf<K extends keyof CompanyFilter> = Extract<NonNullable<CompanyFilter[K]>, string>;
export type EmployeeRange = EnumOf<'employees'>;
export type RevenueRange = EnumOf<'revenue'>;

// Runtime copies of the API enums. `satisfies` makes the compiler reject any value the SDK types do not know.
export const EMPLOYEE_RANGES = [
  '1-10', '11-50', '51-200', '201-500', '501-1K', '1K-5K', '5K-10K', 'over-10K',
] as const satisfies readonly EmployeeRange[];
export const REVENUE_RANGES = [
  'under-1m', '1m-10m', '10m-50m', '50m-100m', '100m-200m', '200m-1b', 'over-1b',
] as const satisfies readonly RevenueRange[];
const CATEGORIES = [
  'b2b', 'b2c', 'b2g', 'e-commerce', 'media', 'service-provider', 'mobile', 'saas', 'local-business',
] as const satisfies readonly EnumOf<'categories'>[];
const COMPANY_TYPES = [
  'private', 'public', 'self-employed', 'self-owned', 'partnership', 'nonprofit', 'educational', 'government',
] as const satisfies readonly EnumOf<'type'>[];
const FUNDING_ROUNDS = [
  'seed', 'debt_financing', 'angel', 'venture', 'series_a', 'series_b', 'series_c', 'series_d',
  'series_e', 'series_f', 'series_g', 'series_h', 'other',
] as const satisfies readonly EnumOf<'fundingRounds'>[];
const REQUIRED_FEATURES = [
  'linkedin', 'twitter', 'facebook', 'instagram', 'angellist', 'crunchbase', 'youtube',
  'country', 'city', 'state', 'revenue', 'foundedYear', 'anyFunding',
] as const satisfies readonly EnumOf<'require'>[];

type WorkforceGrowth = NonNullable<CompanyFilter['workforceGrowth']>;
const GROWTH_PERIODS = ['m6', 'y1', 'y2'] as const satisfies readonly NonNullable<WorkforceGrowth['period']>[];
const WORKFORCE_DEPARTMENTS = [
  'overall', 'c_suite', 'product_management', 'engineering_technical', 'design', 'education', 'finance',
  'human_resources', 'information_technology', 'legal', 'marketing', 'medical_health', 'operations', 'sales', 'consulting',
] as const satisfies readonly NonNullable<WorkforceGrowth['department']>[];

type AdvancedKey = 'in' | 'notIn' | 'all';

/** How one filter field is shaped, so typos inside it are caught too. */
type FieldSpec =
  /** A value, an array, or an advanced object with the listed keys. `values` restricts the allowed strings. */
  | { kind: 'list'; advanced: readonly AdvancedKey[]; values?: readonly string[]; pattern?: RegExp }
  | { kind: 'range' }
  | { kind: 'workforceGrowth' }
  | { kind: 'workforceSize' }
  /** Geography: the planner adds the country and one state per count itself. */
  | { kind: 'planner' };

const IN_NOT_IN: readonly AdvancedKey[] = ['in', 'notIn'];
const IN_NOT_IN_ALL: readonly AdvancedKey[] = ['in', 'notIn', 'all'];

/**
 * Every v2 CompanySearchFilter field. Typed as a Record over the SDK's keys, so the compiler fails
 * if the SDK adds or renames a field. Anything not listed here is rejected before the first request,
 * so a typo never reaches a count.
 */
const FIELDS: Record<keyof CompanyFilter, FieldSpec> = {
  query: { kind: 'list', advanced: IN_NOT_IN },
  id: { kind: 'list', advanced: IN_NOT_IN },
  domain: { kind: 'list', advanced: IN_NOT_IN },
  keywords: { kind: 'list', advanced: IN_NOT_IN_ALL },
  technologies: { kind: 'list', advanced: IN_NOT_IN_ALL },
  region: { kind: 'planner' },
  country: { kind: 'planner' },
  state: { kind: 'planner' },
  city: { kind: 'planner' },
  type: { kind: 'list', advanced: IN_NOT_IN, values: COMPANY_TYPES },
  employees: { kind: 'list', advanced: IN_NOT_IN, values: EMPLOYEE_RANGES },
  reportedEmployees: { kind: 'list', advanced: IN_NOT_IN, values: EMPLOYEE_RANGES },
  revenue: { kind: 'list', advanced: IN_NOT_IN, values: REVENUE_RANGES },
  workforceGrowth: { kind: 'workforceGrowth' },
  workforceSize: { kind: 'workforceSize' },
  naicsCodes: { kind: 'list', advanced: IN_NOT_IN_ALL, pattern: /^\s*[1-9]\d{1,5}\s*$/ },
  categories: { kind: 'list', advanced: IN_NOT_IN_ALL, values: CATEGORIES },
  foundedYear: { kind: 'range' },
  fundingRounds: { kind: 'list', advanced: IN_NOT_IN, values: FUNDING_ROUNDS },
  fundingAmount: { kind: 'range' },
  fundingYear: { kind: 'range' },
  require: { kind: 'list', advanced: ['all'], values: REQUIRED_FEATURES },
};

const KNOWN_FIELDS = Object.keys(FIELDS).filter((field) => FIELDS[field as keyof CompanyFilter].kind !== 'planner');

/** Common names people reach for that v2 spells differently. */
const FIELD_HINTS: Record<string, string> = {
  industry: 'v2 has no industry filter: use "naicsCodes" (codes from the free industries list) or "categories" (b2b, saas, ...)',
  industries: 'v2 has no industry filter: use "naicsCodes" (codes from the free industries list) or "categories" (b2b, saas, ...)',
  size: 'use "employees" for size bands such as 51-200',
  headcount: 'use "employees" for size bands, or "workforceSize" for department headcounts',
  tech: 'use "technologies"',
  techStack: 'use "technologies"',
  location: 'leave geography out; the planner sets the country (--country) and one state per count',
};

/** Edit distance, used to suggest the field a typo probably meant. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase() ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

function suggestField(field: string): string {
  const hint = Object.hasOwn(FIELD_HINTS, field) ? FIELD_HINTS[field] : undefined;
  if (hint) return hint;
  const [closest] = [...KNOWN_FIELDS].sort((a, b) => distance(field, a) - distance(field, b));
  if (closest && distance(field, closest) <= 3) return `did you mean "${closest}"?`;
  return `known fields: ${KNOWN_FIELDS.join(', ')}`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(where: string, message: string): never {
  throw new UsageError(`${where}: ${message}`);
}

function checkKeys(where: string, path: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(where, `"${path}" has unknown key "${key}" (allowed: ${allowed.join(', ')}).`);
  }
}

function checkListValue(where: string, path: string, value: unknown, spec: Extract<FieldSpec, { kind: 'list' }>): void {
  if (typeof value !== 'string') fail(where, `"${path}" values must be strings, got ${JSON.stringify(value)}.`);
  if (spec.values && !spec.values.includes(value)) {
    fail(where, `"${path}" has unknown value ${JSON.stringify(value)}. Allowed: ${spec.values.join(', ')}.`);
  }
  if (spec.pattern && !spec.pattern.test(value)) {
    fail(where, `"${path}" value ${JSON.stringify(value)} is not a NAICS code (2 to 6 digits, no leading zero).`);
  }
}

function checkNumber(where: string, path: string, value: unknown): void {
  if (value !== null && typeof value !== 'number') fail(where, `"${path}" must be a number, got ${JSON.stringify(value)}.`);
}

function checkEnum(where: string, path: string, value: unknown, allowed: readonly string[]): void {
  if (value !== null && (typeof value !== 'string' || !allowed.includes(value))) {
    fail(where, `"${path}" has unknown value ${JSON.stringify(value)}. Allowed: ${allowed.join(', ')}.`);
  }
}

function checkField(where: string, field: string, value: unknown, spec: FieldSpec): void {
  switch (spec.kind) {
    case 'planner':
      return fail(where, `remove "${field}"; the planner sets the country (--country) and one state per count itself.`);
    case 'list':
      if (Array.isArray(value)) {
        value.forEach((item) => checkListValue(where, field, item, spec));
      } else if (isObject(value)) {
        checkKeys(where, field, value, spec.advanced);
        for (const [key, list] of Object.entries(value)) {
          if (!Array.isArray(list)) fail(where, `"${field}.${key}" must be an array.`);
          list.forEach((item) => checkListValue(where, `${field}.${key}`, item, spec));
        }
      } else {
        checkListValue(where, field, value, spec);
      }
      return;
    case 'range':
      if (!isObject(value)) return fail(where, `"${field}" must be an object like {"min": 2015, "max": 2024}.`);
      checkKeys(where, field, value, ['min', 'max']);
      Object.entries(value).forEach(([key, bound]) => checkNumber(where, `${field}.${key}`, bound));
      return;
    case 'workforceGrowth':
      if (!isObject(value)) return fail(where, `"${field}" must be an object like {"period": "y1", "min": 0.1}.`);
      checkKeys(where, field, value, ['period', 'department', 'min', 'max']);
      if ('period' in value) checkEnum(where, `${field}.period`, value.period, GROWTH_PERIODS);
      if ('department' in value) checkEnum(where, `${field}.department`, value.department, WORKFORCE_DEPARTMENTS);
      for (const key of ['min', 'max']) if (key in value) checkNumber(where, `${field}.${key}`, value[key]);
      return;
    case 'workforceSize':
      if (!Array.isArray(value)) return fail(where, `"${field}" must be an array like [{"department": "sales", "min": 5}].`);
      value.forEach((entry, index) => {
        const path = `${field}[${index}]`;
        if (!isObject(entry)) fail(where, `"${path}" must be an object.`);
        checkKeys(where, path, entry, ['department', 'min', 'max']);
        if ('department' in entry) checkEnum(where, `${path}.department`, entry.department, WORKFORCE_DEPARTMENTS);
        for (const key of ['min', 'max']) if (key in entry) checkNumber(where, `${path}.${key}`, entry[key]);
      });
      return;
  }
}

/**
 * Validates a parsed ICP filter against the v2 CompanySearchFilter shape and returns it typed.
 * `where` names the source in error messages. Runs before any API call.
 */
export function parseIcp(raw: unknown, where: string): CompanyFilter {
  if (!isObject(raw)) fail(where, 'expected a JSON object with company search filters, like examples/icp.json.');
  for (const [field, value] of Object.entries(raw)) {
    const spec = Object.hasOwn(FIELDS, field) ? FIELDS[field as keyof CompanyFilter] : undefined;
    if (!spec) fail(where, `"${field}" is not a v2 company filter field; ${suggestField(field)}.`);
    if (value === null && spec.kind !== 'planner') continue;
    checkField(where, field, value, spec);
  }
  return raw as CompanyFilter;
}

export async function loadIcp(path: string): Promise<CompanyFilter> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new UsageError(`Cannot read the ICP file "${path}". Pass --icp examples/icp.json or your own filter file.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  return parseIcp(raw, path);
}

/**
 * The bands of `all` that a filter value selects, in `all` order.
 * Undefined means "no filter", so every band applies.
 */
export function selectedBands<T extends string>(value: unknown, all: readonly T[]): T[] {
  if (value === undefined || value === null) return [...all];
  if (typeof value === 'string') return all.filter((band) => band === value);
  if (Array.isArray(value)) return all.filter((band) => value.includes(band));
  const { in: included, notIn: excluded } = value as { in?: string[]; notIn?: string[] };
  return all.filter((band) => (!included || included.includes(band)) && !excluded?.includes(band));
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(describeValue).join(', ');
  if (value !== null && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, inner]) => `${key} ${describeValue(inner)}`)
      .join('; ');
  }
  return String(value);
}

/** A one-line, human-readable summary of the ICP filter, e.g. "categories: b2b, saas · employees: 51-200". */
export function describeIcp(filter: CompanyFilter): string {
  const parts = Object.entries(filter).map(([field, value]) => `${field}: ${describeValue(value)}`);
  return parts.length > 0 ? parts.join(' · ') : 'all companies';
}
