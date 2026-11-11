import type { PersonSearchQuery } from '@companyenrich/sdk';
import { resolveAccount } from './accounts';
import type { EnrichClient } from './client';
import { MAX_CONCURRENCY, mapWithConcurrency } from './concurrency';
import { adaptForSize } from './size';
import type { Account, AccountCoverage, Blueprint, CoveragePlan, RoleCoverage, RoleSpec, UnresolvedAccount } from './types';

/**
 * Investors and board members often appear as a current "founder" or "c-suite" at
 * their portfolio companies. They are not buyers, so every role excludes them.
 */
const EXCLUDED_TITLES = ['investor', 'board member', 'board of directors', 'advisory board'];

/** The people filter for one role at one account. Shared by the free count and the paid search. */
export function roleFilter(domain: string, role: RoleSpec): NonNullable<PersonSearchQuery['filter']> {
  return {
    domain,
    seniority: role.seniority,
    ...(role.department.length > 0 ? { department: role.department } : {}),
    position: role.position.length > 0 ? { in: role.position, notIn: EXCLUDED_TITLES } : { notIn: EXCLUDED_TITLES },
  };
}

export async function countRole(client: EnrichClient, domain: string, role: RoleSpec): Promise<number> {
  const { count } = await client.people.count({ filter: roleFilter(domain, role) });
  return count;
}

/** Fewer than two roles have anyone in them: the deal depends on one thread. */
function isSingleThreaded(roles: readonly RoleCoverage[]): boolean {
  return roles.filter((role) => role.count > 0).length <= 1;
}

/**
 * Step 1, free: resolve every account, adapt the committee to its size and count
 * matching people per role. Costs 0 credits however many accounts you pass.
 */
export async function buildCoverage(client: EnrichClient, domains: readonly string[], blueprint: Blueprint): Promise<CoveragePlan> {
  const resolved = await mapWithConcurrency(domains, MAX_CONCURRENCY, (domain) => resolveAccount(client, domain));

  const accounts: Account[] = [];
  const unresolved: UnresolvedAccount[] = [];
  for (const result of resolved) {
    if (result.ok) accounts.push(result.account);
    else unresolved.push(result.unresolved);
  }

  const committees = accounts.map((account) => ({ account, ...adaptForSize(blueprint, account.band) }));

  // One flat list of (account, role) pairs so the concurrency cap applies across all accounts.
  const pairs = committees.flatMap((committee) => committee.roles.map((role) => ({ domain: committee.account.domain, role })));
  const counts = await mapWithConcurrency(pairs, MAX_CONCURRENCY, ({ domain, role }) => countRole(client, domain, role));

  let offset = 0;
  const coverage: AccountCoverage[] = committees.map(({ account, roles, adaptation }) => {
    const roleCoverage = roles.map((role, index) => ({ role, count: counts[offset + index]! }));
    offset += roles.length;
    return { account, adaptation, roles: roleCoverage, singleThreaded: isSingleThreaded(roleCoverage) };
  });

  return { blueprint, accounts: coverage, unresolved };
}
