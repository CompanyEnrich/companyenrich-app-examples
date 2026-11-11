import type { EnrichClient } from './client';
import { bandFor, EMPLOYEE_RANGES } from './size';
import type { Account, EmployeeRange, UnresolvedAccount } from './types';

export type ResolvedAccount = { ok: true; account: Account } | { ok: false; unresolved: UnresolvedAccount };

/**
 * Identify an account with free calls only:
 * - `companies.autocomplete` confirms the domain exists and gives its name and id;
 * - `companies.count` with an `employees` filter reveals its size range (see below).
 */
export async function resolveAccount(client: EnrichClient, domain: string): Promise<ResolvedAccount> {
  const { items } = await client.companies.autocomplete(domain);
  const match = items.find((item) => item.domain === domain);
  if (!match) {
    return { ok: false, unresolved: { domain, reason: 'No company with this exact domain in CompanyEnrich.' } };
  }
  const employees = await findEmployeeRange(client, domain);
  return {
    ok: true,
    account: { domain, name: match.name ?? domain, companyId: match.id, employees, band: bandFor(employees) },
  };
}

/**
 * `companies.enrich` would return the range for 1 credit. Counting is free, so we
 * binary-search the 8 ranges instead: "is this domain in the first half?" and so on.
 * That is 2 to 4 counts and keeps the whole coverage step at 0 credits.
 */
export async function findEmployeeRange(client: EnrichClient, domain: string): Promise<EmployeeRange | null> {
  const matches = async (ranges: readonly EmployeeRange[]) =>
    (await client.companies.count({ filter: { domain, employees: [...ranges] } })).count > 0;

  let candidates: readonly EmployeeRange[] = EMPLOYEE_RANGES;
  if (!(await matches(candidates.slice(0, 4)))) {
    candidates = candidates.slice(4);
    if (!(await matches(candidates))) return null;
  } else {
    candidates = candidates.slice(0, 4);
  }
  while (candidates.length > 1) {
    const firstHalf = candidates.slice(0, candidates.length / 2);
    candidates = (await matches(firstHalf)) ? firstHalf : candidates.slice(candidates.length / 2);
  }
  return candidates[0]!;
}
