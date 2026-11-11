import type { CompanySearchQuery } from '@companyenrich/sdk';
import type { EmployeeRange } from './types.js';

/**
 * People searches with a semantic company query cover people at this many best-matching companies
 * (SDK docs, "People at matching companies"). Filter-only company queries have no such limit.
 */
export const SEMANTIC_COMPANY_LIMIT = 1000;

/** The kind of company the best candidates work at, from the CLI flags. */
export interface EnvironmentInput {
  /** Plain-English description, sent as a semantic query. */
  description?: string;
  /** Every technology must be in the company's stack. */
  technologies: string[];
  employees: EmployeeRange[];
  /** Headquarters country, ISO 3166-1 alpha-2. */
  country?: string;
}

/**
 * Builds the `company` query for people search and the free companies.count.
 * Returns undefined when no environment was given, which means "people at any company".
 */
export function buildCompanyQuery(input: EnvironmentInput): CompanySearchQuery | undefined {
  const filter: NonNullable<CompanySearchQuery['filter']> = {};
  if (input.technologies.length > 0) filter.technologies = { all: input.technologies };
  if (input.employees.length > 0) filter.employees = input.employees;
  if (input.country) filter.country = input.country;

  const query: CompanySearchQuery = {};
  if (input.description) query.semantic = { query: input.description };
  if (Object.keys(filter).length > 0) query.filter = filter;
  return Object.keys(query).length > 0 ? query : undefined;
}

/** One line for logs and the report, e.g. `"fintech companies" · HQ in US · 201-500 or 501-1K employees`. */
export function describeEnvironment(input: EnvironmentInput): string {
  const parts = [
    input.description ? `"${input.description}"` : undefined,
    input.country ? `HQ in ${input.country}` : undefined,
    input.employees.length > 0 ? `${input.employees.join(' or ')} employees` : undefined,
    input.technologies.length > 0 ? `uses ${input.technologies.join(' and ')}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(' · ') : 'any company';
}

export interface TechnologyCheck {
  known: string[];
  unknown: { name: string; suggestions: string[] }[];
}

/**
 * Keeps technologies that technologies.autocomplete knows by exact name. An unknown name inside an
 * `all` filter would match no company at all, so the caller rejects it before spending anything.
 */
export function checkTechnologies(requested: readonly string[], suggestions: ReadonlyMap<string, readonly string[]>): TechnologyCheck {
  const result: TechnologyCheck = { known: [], unknown: [] };
  for (const name of requested) {
    const items = suggestions.get(name) ?? [];
    const match = items.find((item) => item.toLowerCase() === name.toLowerCase());
    if (match) result.known.push(match);
    else result.unknown.push({ name, suggestions: [...items] });
  }
  return result;
}

/** Renders a filter object for people, e.g. `country: US; employees: 51-200 or 201-500; fundingRounds: venture`. */
export function formatFilter(filter: object): string {
  const value = (rule: unknown): string => {
    if (Array.isArray(rule)) return rule.join(' or ');
    if (rule !== null && typeof rule === 'object') {
      const { in: anyOf, all, notIn } = rule as { in?: unknown[]; all?: unknown[]; notIn?: unknown[] };
      const parts = [anyOf && anyOf.join(' or '), all && all.join(' and '), notIn && `not ${notIn.join(' or ')}`].filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : JSON.stringify(rule);
    }
    return String(rule);
  };
  return Object.entries(filter)
    .map(([key, rule]) => `${key}: ${value(rule)}`)
    .join('; ');
}
