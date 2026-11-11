import type { Company } from '@companyenrich/sdk';
import { EMPLOYEE_RANGES, type IcpCriteria, REVENUE_RANGES } from './config.js';

export type CriterionName = keyof IcpCriteria;

export interface CriterionScore {
  criterion: CriterionName;
  /** What the company has, or null when CompanyEnrich has no value for it. */
  value: string | null;
  points: number;
  max: number;
  verdict: 'match' | 'near' | 'miss' | 'unknown';
}

export interface IcpScore {
  /** 0 to 100: points earned as a share of the total weight. */
  score: number;
  fit: 'strong' | 'partial' | 'weak';
  parts: CriterionScore[];
}

const STRONG_FIT = 70;
const PARTIAL_FIT = 40;

/**
 * Scores a company against the ICP. Each criterion earns its full weight on a match. For employee
 * and revenue bands, a band next to an accepted one earns half, so a 1K-5K company is not treated
 * like a 1-10 one when you asked for 201-500 to 501-1K. Unknown values earn nothing.
 */
export function scoreCompany(company: Company, icp: IcpCriteria): IcpScore {
  const parts: CriterionScore[] = [];
  if (icp.employees) parts.push(scoreBand('employees', company.employees ?? null, icp.employees, EMPLOYEE_RANGES));
  if (icp.revenue) parts.push(scoreBand('revenue', company.revenue ?? null, icp.revenue, REVENUE_RANGES));
  if (icp.categories) {
    const categories = company.categories ?? [];
    const matched = categories.some((category) => icp.categories!.match.includes(category));
    parts.push(scoreSet('categories', categories.length > 0 ? categories.join(', ') : null, matched, icp.categories.weight));
  }
  if (icp.country) {
    const country = company.location?.country?.code?.toUpperCase() ?? null;
    parts.push(scoreSet('country', country, country !== null && icp.country.match.includes(country), icp.country.weight));
  }

  const max = parts.reduce((sum, part) => sum + part.max, 0);
  const earned = parts.reduce((sum, part) => sum + part.points, 0);
  const score = max === 0 ? 0 : Math.round((earned / max) * 100);
  return { score, fit: score >= STRONG_FIT ? 'strong' : score >= PARTIAL_FIT ? 'partial' : 'weak', parts };
}

function scoreBand<T extends string>(
  criterion: CriterionName,
  value: T | null,
  rule: { weight: number; match: T[] },
  order: readonly T[],
): CriterionScore {
  const base = { criterion, value, max: rule.weight };
  if (value === null) return { ...base, points: 0, verdict: 'unknown' };
  if (rule.match.includes(value)) return { ...base, points: rule.weight, verdict: 'match' };
  const index = order.indexOf(value);
  const near = rule.match.some((accepted) => Math.abs(order.indexOf(accepted) - index) === 1);
  return near ? { ...base, points: rule.weight / 2, verdict: 'near' } : { ...base, points: 0, verdict: 'miss' };
}

function scoreSet(criterion: CriterionName, value: string | null, matched: boolean, weight: number): CriterionScore {
  const base = { criterion, value, max: weight };
  if (value === null) return { ...base, points: 0, verdict: 'unknown' };
  return matched ? { ...base, points: weight, verdict: 'match' } : { ...base, points: 0, verdict: 'miss' };
}
