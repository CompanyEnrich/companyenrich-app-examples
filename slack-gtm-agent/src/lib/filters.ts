/**
 * Helpers for the filters the API reports in a count's `interpretation`.
 *
 * Counts run on the v2 API (SDK) and report filters in the v2 vocabulary, while the MCP
 * search tools take their own parameter names. `peopleSearchArgs` converts one into the
 * other for `/ce people`, so the paid fetch asks for exactly what the free count counted.
 */

type Json = Record<string, unknown>;

interface Values {
  include: string[];
  exclude: string[];
}

function record(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined).map(String);
  if (value === null || value === undefined) return [];
  return [String(value)];
}

/** A filter value can be a value, an array, or `{ in, notIn, all }`. */
function values(value: unknown): Values {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const rule = value as Json;
    return { include: [...strings(rule.in), ...strings(rule.all)], exclude: strings(rule.notIn) };
  }
  return { include: strings(value), exclude: [] };
}

function describeValue(value: unknown): string {
  const rule = record(value);
  if ('min' in rule || 'max' in rule) return `${rule.min ?? 'any'} to ${rule.max ?? 'any'}`;
  if ('after' in rule || 'before' in rule) return `${rule.after ?? 'any'} to ${rule.before ?? 'any'}`;
  const { include, exclude } = values(value);
  if (include.length === 0 && exclude.length === 0) return JSON.stringify(value);
  return [include.join(', '), exclude.length ? `not ${exclude.join(', ')}` : ''].filter(Boolean).join('; ');
}

/** `{ seniority: { in: ['vp'] } }` -> `['seniority: vp']`. City and state values are CompanyEnrich ids. */
export function describeFilter(filter: unknown): string[] {
  return Object.entries(record(filter)).map(([key, value]) => `${key}: ${describeValue(value)}`);
}

export type PeopleArgsResult =
  | { ok: true; args: Json; filters: string[] }
  | { ok: false; reason: string };

const LIST_FILTERS: Record<string, string> = {
  seniority: 'seniority',
  department: 'department',
  position: 'positionQuery',
  country: 'countries',
};

const DATE_FILTERS: Record<string, [after: string, before: string]> = {
  currentCompanyStartDate: ['atCurrentCompanyAfter', 'atCurrentCompanyBefore'],
  currentPositionStartDate: ['atCurrentPositionAfter', 'atCurrentPositionBefore'],
};

function toDateTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return value.includes('T') ? value : `${value}T00:00:00Z`;
}

/**
 * Build MCP `search_people` arguments from a `count_people` interpretation.
 * Fails (without spending anything) if the interpretation uses a filter that the MCP
 * tool cannot express, so a paid fetch never silently drops part of the question.
 */
export function peopleSearchArgs(domain: string, interpretation: unknown, pageSize: number): PeopleArgsResult {
  const reading = record(interpretation);
  if (reading.company || reading.companyNames) {
    return { ok: false, reason: 'the role words also describe a company; put the company in the domain argument instead' };
  }

  const filter = record(reading.filter);
  const args: Json = { domains: [domain] };
  const exclude: Json = {};

  for (const [key, value] of Object.entries(filter)) {
    if (key === 'domain') continue;
    const listParam = LIST_FILTERS[key];
    const dateParams = DATE_FILTERS[key];
    if (listParam) {
      const { include, exclude: excluded } = values(value);
      if (include.length) args[listParam] = include;
      if (excluded.length) exclude[listParam] = excluded;
    } else if (dateParams) {
      const range = record(value);
      const after = toDateTime(range.after);
      const before = toDateTime(range.before);
      if (after) args[dateParams[0]] = after;
      if (before) args[dateParams[1]] = before;
    } else {
      return { ok: false, reason: `the API read the role words as a "${key}" filter, which the people search tool cannot apply` };
    }
  }

  if (Object.keys(exclude).length) args.exclude = exclude;
  args.pageSize = pageSize;
  return { ok: true, args, filters: describeFilter(filter) };
}
