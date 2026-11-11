import type { CompanyEnrich } from '@companyenrich/sdk';
import { MAX_CONCURRENCY, mapLimit } from './concurrency.js';
import { COST, searchCharge, type CostLine, type CreditLedger } from './credits.js';
import { personFilter, type Persona } from './personas.js';
import type { Account, CompanyFilter, Contact, ContactMatch, Log, PersonFilter } from './types.js';

export interface ContactPlanItem {
  account: Account;
  /** People matching the chosen level at this account (free count). */
  available: number;
  /** How many to fetch: min(--contacts, available). */
  take: number;
  /** The persona level that has people here. Undefined when neither level has anyone. */
  target?: { match: ContactMatch; filter: PersonFilter } | undefined;
}

/**
 * Free: how many people at target companies match the persona. Runs before any spend, so a
 * filter the API rejects fails here rather than on a paid call. People queries with a company
 * filter cover the 1,000 best-matching companies.
 */
export async function personaReach(client: CompanyEnrich, persona: Persona, companyFilter: CompanyFilter): Promise<number> {
  const { total } = await client.people.count({ filter: persona.primary, company: { filter: companyFilter } });
  return total;
}

/** Free: per-account people counts, persona first, then its broader fallback when the persona has nobody. */
export async function planContacts(client: CompanyEnrich, accounts: readonly Account[], persona: Persona, perAccount: number): Promise<ContactPlanItem[]> {
  if (perAccount === 0) return accounts.map((account) => ({ account, available: 0, take: 0 }));

  return mapLimit(accounts, MAX_CONCURRENCY, async (account) => {
    for (const [match, level] of [['persona', persona.primary], ['fallback', persona.fallback]] as const) {
      const filter = personFilter(level, account.company.domain);
      const { count } = await client.people.count({ filter });
      if (count > 0) return { account, available: count, take: Math.min(perAccount, count), target: { match, filter } };
    }
    return { account, available: 0, take: 0 };
  });
}

export function estimateContacts(plan: readonly ContactPlanItem[]): CostLine {
  const people = plan.reduce((sum, item) => sum + item.take, 0);
  const accounts = plan.filter((item) => item.take > 0).length;
  return { step: 'contacts', detail: `${people} people at ${accounts} accounts x ${COST.person}`, credits: people * COST.person };
}

/** Upper bound before accounts are fetched: every account yields the full --contacts. */
export function estimateContactsUpperBound(accounts: number, perAccount: number): CostLine {
  return { step: 'contacts', detail: `up to ${accounts * perAccount} people x ${COST.person}`, credits: accounts * perAccount * COST.person };
}

/**
 * Paid: one people search per account that has someone to find. Accounts with a zero count are
 * skipped. Each page is recorded and appended to `contacts` as soon as it arrives; if one search
 * fails, no new searches start, the ones in flight finish, and then the error is rethrown.
 */
export async function fetchContacts(
  client: CompanyEnrich,
  plan: readonly ContactPlanItem[],
  ledger: CreditLedger,
  log: Log,
  contacts: Contact[],
): Promise<void> {
  await mapLimit(plan, MAX_CONCURRENCY, async ({ account, take, target }) => {
    if (!target || take === 0) {
      log(`   ${account.company.domain}: nobody matches the persona or its fallback (no credits)`);
      return;
    }
    const page = await client.people.search({ filter: target.filter, pageSize: take });
    const charged = searchCharge(page.items.length, COST.person);
    ledger.record('contacts', `${account.company.domain}: ${page.items.length} of ${take} people`, take * COST.person, charged);
    log(`   ${account.company.domain}: ${page.items.length} ${target.match} contact(s) (${charged} credits)`);
    contacts.push(...page.items.map((person): Contact => ({ account, person, match: target.match })));
  });
}
