import type { components } from '@companyenrich/sdk';

type CompanySearchFilter = NonNullable<components['schemas']['CompanySearchFilter']>;

/** The keys each field accepts when written as an object rather than a value or list. */
type Shape = readonly string[] | 'workforceSize';

const RULE = ['in', 'notIn'] as const;
const COLLECTION_RULE = ['in', 'notIn', 'all'] as const;
const RANGE = ['min', 'max'] as const;

/**
 * Every v2 company filter field. Typed against the SDK, so the compiler flags a field the API
 * adds or removes. Keys are checked against this list, so a typo fails before any paid search.
 */
const FIELDS: Record<keyof CompanySearchFilter, Shape> = {
  query: RULE,
  id: RULE,
  domain: RULE,
  keywords: COLLECTION_RULE,
  technologies: COLLECTION_RULE,
  region: RULE,
  country: RULE,
  state: RULE,
  city: RULE,
  type: RULE,
  employees: RULE,
  reportedEmployees: RULE,
  revenue: RULE,
  workforceGrowth: ['period', 'department', 'min', 'max'],
  workforceSize: 'workforceSize',
  naicsCodes: COLLECTION_RULE,
  categories: COLLECTION_RULE,
  foundedYear: RANGE,
  fundingRounds: RULE,
  fundingAmount: RANGE,
  fundingYear: RANGE,
  require: ['all'],
};

/** Words people reach for that are not field names. */
const HINTS: Record<string, string> = {
  industry: 'naicsCodes (codes from `industries.list()`), keywords or categories',
  industries: 'naicsCodes (codes from `industries.list()`), keywords or categories',
  location: 'country, state, city or region',
  size: 'employees',
  headcount: 'employees or workforceSize',
  founded: 'foundedYear',
  funding: 'fundingRounds, fundingAmount or fundingYear',
  tech: 'technologies',
};

export interface FilterIssue {
  path: (string | number)[];
  message: string;
}

/** Checks the keys of a company search filter, including those inside advanced rules. */
export function checkCompanyFilter(filter: Record<string, unknown>): FilterIssue[] {
  const issues: FilterIssue[] = [];
  for (const [field, value] of Object.entries(filter)) {
    if (!Object.hasOwn(FIELDS, field)) {
      issues.push({ path: [field], message: `Unknown company filter field "${field}". ${suggest(field, Object.keys(FIELDS))}` });
      continue;
    }
    const shape = FIELDS[field as keyof CompanySearchFilter];
    if (shape === 'workforceSize') {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => issues.push(...checkKeys(entry, ['department', 'min', 'max'], [field, index])));
      }
      continue;
    }
    issues.push(...checkKeys(value, shape, [field]));
  }
  return issues;
}

function checkKeys(value: unknown, allowed: readonly string[], path: (string | number)[]): FilterIssue[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({
      path: [...path, key],
      message: `Unknown key "${key}" in ${path.join('.')}. ${suggest(key, allowed)}`,
    }));
}

function suggest(word: string, options: readonly string[]): string {
  const hint = HINTS[word.toLowerCase()];
  if (hint) return `Use ${hint}.`;
  const closest = options
    .map((option) => ({ option, distance: editDistance(word.toLowerCase(), option.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance)[0];
  if (closest && closest.distance <= Math.max(2, Math.floor(word.length / 3))) return `Did you mean "${closest.option}"?`;
  return `Expected one of: ${options.join(', ')}.`;
}

/** Levenshtein distance: the number of single-character edits between two words. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
