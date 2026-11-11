import { NotFoundError } from '@companyenrich/sdk';
import type { EnrichClient } from './client';
import { createLimiter, MAX_CONCURRENCY, type Limiter } from './concurrency';
import { countRole, roleFilter } from './coverage';
import { estimateCredits, PRICES, type CreditBudget } from './credits';
import { describeError } from './errors';
import { describeFilters, gapSuggestion } from './gaps';
import { mayHaveBeenCharged, PAID_GET_OPTIONS, retryOnRateLimit } from './paid-calls';
import { rankCandidates, toMappedPerson } from './ranking';
import type { Account, AccountCoverage, AccountMap, CommitteeMap, CoveragePlan, Gap, MappedPerson, RoleResult, RoleSpec } from './types';
import { UserFacingError } from './user-error';
import { workforceVerdict, type DepartmentHeadcount } from './workforce';

export interface MapOptions {
  /** Run the 1-credit workforce check per account before searching. */
  workforce: boolean;
  /** Hard cap for this run. It refuses to start if the searches and workforce checks do not fit. */
  budget: CreditBudget;
  now?: Date;
}

/** A role after the workforce check and search, before people are assigned. */
interface SearchedRole {
  role: RoleSpec;
  count: number;
  candidates: MappedPerson[];
  notes: string[];
  /** Set when the role was not searched for a reason other than a zero count. */
  skipped?: string;
}

/** Shared by every account in one run. */
interface RunContext {
  client: EnrichClient;
  budget: CreditBudget;
  /** One concurrency cap for all API calls in the run. */
  limit: Limiter;
  workforce: boolean;
  now: Date;
  /** Set by the first paid call that fails; later paid calls are skipped. */
  stoppedEarly: string | null;
}

const STOPPED = 'Not searched: the run stopped after an error.';

/**
 * Step 2, paid: search people for every role with matches, rank them, assign each
 * person to one role and list the gaps. Never spends more than the budget allows.
 * If a paid call fails midway, the people already paid for are kept and returned.
 */
export async function mapCommittee(client: EnrichClient, plan: CoveragePlan, options: MapOptions): Promise<CommitteeMap> {
  const estimate = estimateCredits(plan, { workforce: options.workforce });
  const required = estimate.searchCredits + estimate.workforceCredits;
  if (required > options.budget.available) {
    throw new UserFacingError(
      `Mapping these accounts costs ${required} credits but only ${options.budget.available} are available under the cap. Raise the cap or map fewer accounts.`,
    );
  }

  const spentBefore = options.budget.spent;
  const run: RunContext = {
    client,
    budget: options.budget,
    limit: createLimiter(MAX_CONCURRENCY),
    workforce: options.workforce,
    now: options.now ?? new Date(),
    stoppedEarly: null,
  };
  const accounts = await Promise.all(plan.accounts.map((coverage) => mapAccount(run, coverage)));
  return {
    blueprint: plan.blueprint,
    generatedAt: run.now.toISOString(),
    accounts,
    creditsSpent: options.budget.spent - spentBefore,
    stoppedEarly: run.stoppedEarly,
  };
}

async function mapAccount(run: RunContext, coverage: AccountCoverage): Promise<AccountMap> {
  const { account } = coverage;
  const adaptation = [...coverage.adaptation];
  let roles: SearchedRole[] = coverage.roles.map(({ role, count }) => ({ role, count, candidates: [], notes: [] }));
  const searched = new Set<SearchedRole>();

  try {
    if (run.workforce && !run.stoppedEarly) {
      const observed = await fetchWorkforce(run, account.domain);
      if (observed === null) {
        adaptation.push('Workforce check: no workforce data for this company, roles unchanged.');
      } else {
        adaptation.push(`Workforce check: ${observed.employees} people observed; empty roles were checked against department headcounts.`);
        roles = await Promise.all(roles.map((entry) => applyWorkforce(run, account.domain, entry, observed.headcount)));
      }
    }

    // Searches run in priority order so the most important roles get budget first.
    roles.sort((a, b) => a.role.priority - b.role.priority);
    for (const entry of roles) {
      if (entry.skipped || entry.count === 0) continue;
      if (run.stoppedEarly) break;
      entry.candidates = await searchRole(run, account.domain, entry);
      searched.add(entry);
    }
  } catch (error) {
    run.stoppedEarly ??= describeError(error);
  }

  for (const entry of roles) {
    if (entry.count > 0 && !entry.skipped && !searched.has(entry)) entry.skipped = STOPPED;
  }
  const { results, gaps } = assignPeople(roles, account);
  const mappedPeople = results.reduce((total, result) => total + result.people.length, 0);
  return { account, adaptation, roles: results, gaps, singleThreaded: mappedPeople <= 1 };
}

/** 2 credits per person returned (an empty page still costs one result). */
async function searchRole(run: RunContext, domain: string, entry: SearchedRole): Promise<MappedPerson[]> {
  const pageSize = Math.min(entry.role.limit, entry.count);
  const reserved = pageSize * PRICES.personResult;
  if (!run.budget.reserve(reserved)) {
    entry.skipped = 'Not searched: it would exceed the credit cap.';
    return [];
  }
  let charged = 0;
  try {
    // Paid POSTs are never retried by the SDK after an ambiguous failure, only after a 429.
    const page = await run.limit(() => run.client.people.search({ filter: roleFilter(domain, entry.role), pageSize }));
    charged = Math.max(1, page.items.length) * PRICES.personResult;
    return rankCandidates(
      page.items.map((person) => toMappedPerson(person, domain, run.now)),
      entry.role,
    );
  } catch (error) {
    if (mayHaveBeenCharged(error)) charged = reserved;
    throw error;
  } finally {
    run.budget.settle(reserved, charged);
  }
}

/** 1 credit. Returns null when the API has no workforce data for the company. */
async function fetchWorkforce(run: RunContext, domain: string): Promise<{ employees: number; headcount: DepartmentHeadcount } | null> {
  if (!run.budget.reserve(PRICES.workforcePage)) throw new UserFacingError('The credit cap does not cover the workforce check.');
  let charged = 0;
  try {
    const workforce = await run.limit(() => retryOnRateLimit(() => run.client.companies.workforce({ domain }, PAID_GET_OPTIONS)));
    charged = PRICES.workforcePage;
    return workforce.observedEmployeeCount > 0 ? { employees: workforce.observedEmployeeCount, headcount: workforce.departmentHeadcount } : null;
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    if (mayHaveBeenCharged(error)) charged = PRICES.workforcePage;
    throw error;
  } finally {
    run.budget.settle(PRICES.workforcePage, charged);
  }
}

async function applyWorkforce(run: RunContext, domain: string, entry: SearchedRole, headcount: DepartmentHeadcount): Promise<SearchedRole> {
  const verdict = workforceVerdict(entry.role, entry.count, headcount);
  switch (verdict.action) {
    case 'keep':
      return verdict.note ? { ...entry, notes: [...entry.notes, verdict.note] } : entry;
    case 'skip':
      return { ...entry, notes: [...entry.notes, verdict.note], skipped: verdict.note };
    case 'relabel': {
      // The relabeled role has new filters, so count it again (free) before searching.
      const count = await run.limit(() => countRole(run.client, domain, verdict.role));
      return { ...entry, role: verdict.role, count, notes: [...entry.notes, verdict.note] };
    }
  }
}

/** Give each person to the highest-priority role they matched, up to each role's limit. */
export function assignPeople(roles: readonly SearchedRole[], account: Account): { results: RoleResult[]; gaps: Gap[] } {
  const assignedTo = new Map<string, string>();
  const results: RoleResult[] = [];
  const gaps: Gap[] = [];

  for (const entry of [...roles].sort((a, b) => a.role.priority - b.role.priority)) {
    const people: MappedPerson[] = [];
    const takenBy = new Set<string>();
    for (const candidate of entry.candidates) {
      const owner = assignedTo.get(candidate.id);
      if (owner) takenBy.add(owner);
      else if (people.length < entry.role.limit) {
        people.push(candidate);
        assignedTo.set(candidate.id, entry.role.label);
      }
    }

    const notes = [...entry.notes];
    if (takenBy.size > 0) notes.push(`Some matches are already mapped as ${[...takenBy].join(', ')}.`);
    results.push({ role: entry.role, count: entry.count, people, notes });

    if (people.length === 0) {
      gaps.push({ roleKey: entry.role.key, label: entry.role.label, reason: gapReason(entry, takenBy, account), suggestion: gapSuggestion(entry.role.key) });
    }
  }
  return { results, gaps };
}

function gapReason(entry: SearchedRole, takenBy: Set<string>, account: Account): string {
  if (entry.skipped) return entry.skipped;
  if (takenBy.size > 0) return `Its only matches are already mapped as ${[...takenBy].join(', ')}; one person may cover both.`;
  if (entry.count === 0) {
    return entry.notes.length > 0 ? entry.notes.join(' ') : `No one at ${account.name} matches ${describeFilters(entry.role)}.`;
  }
  return 'The free count found matches but the search returned none; the data may have just changed.';
}
