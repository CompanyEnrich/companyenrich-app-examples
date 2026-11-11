import { UsageError } from './errors.js';
import type { CompanySearchFilter } from './types.js';

// Edited ICP files are checked against this map first, so a typo such as `employee` fails before
// any paid search.

type Shape = 'values' | 'collection' | 'range' | 'workforceGrowth' | 'workforceSize';

/** Every CompanySearchFilter field and its shape. `satisfies` makes the compiler flag a missing or extra field. */
const FIELDS = {
  query: 'values',
  id: 'values',
  domain: 'values',
  keywords: 'collection',
  technologies: 'collection',
  region: 'values',
  country: 'values',
  state: 'values',
  city: 'values',
  type: 'values',
  employees: 'values',
  reportedEmployees: 'values',
  revenue: 'values',
  workforceGrowth: 'workforceGrowth',
  workforceSize: 'workforceSize',
  naicsCodes: 'collection',
  categories: 'collection',
  foundedYear: 'range',
  fundingRounds: 'values',
  fundingAmount: 'range',
  fundingYear: 'range',
  require: 'collection',
} as const satisfies Record<keyof CompanySearchFilter, Shape>;

const OBJECT_KEYS: Record<Shape, readonly string[]> = {
  values: ['in', 'notIn'],
  collection: ['in', 'notIn', 'all'],
  range: ['min', 'max'],
  workforceGrowth: ['period', 'department', 'min', 'max'],
  workforceSize: ['department', 'min', 'max'],
};

const INDUSTRY_HINT = 'naicsCodes (industry names map to NAICS codes via industries.list()) or categories';
const HINTS: Record<string, string> = {
  industry: INDUSTRY_HINT,
  industries: INDUSTRY_HINT,
  category: 'categories',
  employee: 'employees',
  employeecount: 'employees',
  headcount: 'employees',
  size: 'employees',
  countries: 'country',
  technology: 'technologies',
  tech: 'technologies',
  founded: 'foundedYear',
  year: 'foundedYear',
  domains: 'domain',
};

function suggestion(key: string): string {
  const lower = key.toLowerCase();
  const near = Object.keys(FIELDS).find((field) => {
    const candidate = field.toLowerCase();
    return candidate === lower || candidate === `${lower}s` || `${candidate}s` === lower;
  });
  const hint = HINTS[lower] ?? near;
  return hint ? ` Did you mean ${hint}?` : ` Known fields: ${Object.keys(FIELDS).join(', ')}.`;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function checkObjectKeys(value: Record<string, unknown>, allowed: readonly string[], where: string, source: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new UsageError(`${source}: "${where}" has an unknown key "${unknown}"; use ${allowed.join(', ')}.`);
  }
}

/** Throws a one-line UsageError for the first unknown field or nested key in a filter. */
export function assertKnownFilterKeys(filter: Record<string, unknown>, source: string): void {
  for (const [key, value] of Object.entries(filter)) {
    if (!Object.hasOwn(FIELDS, key)) {
      throw new UsageError(`${source}: unknown filter field "${key}".${suggestion(key)}`);
    }
    const shape: Shape = FIELDS[key as keyof typeof FIELDS];
    if (shape === 'workforceSize' && Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (isPlainObject(entry)) checkObjectKeys(entry, OBJECT_KEYS.workforceSize, `${key}[${index}]`, source);
      });
    } else if (isPlainObject(value)) {
      checkObjectKeys(value, OBJECT_KEYS[shape], key, source);
    }
  }
}
