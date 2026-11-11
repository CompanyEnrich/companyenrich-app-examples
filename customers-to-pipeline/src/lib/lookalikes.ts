import type { CompanySearchQuery, CompanySearchResponse } from '@companyenrich/sdk';
import { matchDimensions } from './icp.js';
import type { Company, CompanySearchFilter, IndustryCodes } from './types.js';

/** Lookalike search takes 1 to 10 seed domains. */
export const MAX_SEEDS = 10;

export interface Customer {
  /** The normalized domain from the CSV. */
  domain: string;
  /** Undefined when the customer was not found or not enriched (for example in a dry run). */
  company?: Company | undefined;
}

/**
 * Seeds are the customers that match the most ICP dimensions; ties keep CSV order. Enriched customers
 * are used when there are any, and each seed is sent as the company's primary domain.
 */
export function selectSeeds(
  customers: readonly Customer[],
  icp: CompanySearchFilter,
  industryCodes: IndustryCodes,
  max = MAX_SEEDS,
): string[] {
  const enriched = customers.filter((customer) => customer.company);
  const pool = enriched.length > 0 ? enriched : customers;
  const ranked = pool
    .map((customer, index) => ({
      index,
      domain: customer.company?.domain ?? customer.domain,
      score: customer.company ? matchDimensions(customer.company, icp, industryCodes).matched.length : 0,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return [...new Set(ranked.map((seed) => seed.domain))].slice(0, max);
}

/** Every domain a customer is known by: as written in the CSV and the API's primary domain. */
export function customerDomains(customers: readonly Customer[]): string[] {
  return [...new Set(customers.flatMap((customer) => [customer.domain, customer.company?.domain ?? customer.domain]))];
}

/**
 * Companies similar to the seeds, inside the ICP, that are not already customers. A `domain` rule in an
 * edited ICP file is replaced by the customer exclusion.
 */
export function buildLookalikeQuery(seeds: readonly string[], icp: CompanySearchFilter, exclude: readonly string[]): CompanySearchQuery {
  return {
    lookalike: { domains: [...seeds] },
    filter: { ...icp, domain: { notIn: [...exclude] } },
  };
}

export interface Account {
  /** 1-based, in the order the API returned (scores are not probabilities, so the order is kept as is). */
  rank: number;
  company: Company;
  score: number | undefined;
  /** ICP dimensions the account matches: the "why" column. */
  matched: string[];
}

export function toAccounts(response: CompanySearchResponse, icp: CompanySearchFilter, industryCodes: IndustryCodes): Account[] {
  return response.items.map((company, index) => ({
    rank: index + 1,
    company,
    score: response.scores?.[company.id],
    matched: matchDimensions(company, icp, industryCodes).matched,
  }));
}
