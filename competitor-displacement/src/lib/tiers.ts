import type { CompanyEnrich, CompanyExpansion } from '@companyenrich/sdk';
import { COST, searchCharge, type CostLine, type CreditLedger } from './credits.js';
import { excludeDomains } from './filters.js';
import { countCompanies } from './sizing.js';
import type { Account, CompanyFilter, Log, Tier } from './types.js';

export const TIERS: readonly Tier[] = [1, 2, 3];

/** Why-now thresholds. Growth is the overall headcount ratio over 6 months: 0.1 means +10%. */
export const GROWTH_MIN = 0.1;
export const MIN_FUNDING_USD = 1_000_000;

const GROWTH_FILTER: NonNullable<CompanyFilter['workforceGrowth']> = { period: 'm6', department: 'overall', min: GROWTH_MIN };

/** "Recently funded" means a latest round dated last calendar year or later, with $1M+ raised. */
export function fundedSinceYear(now: Date): number {
  return now.getUTCFullYear() - 1;
}

function fundingFilter(now: Date): Pick<CompanyFilter, 'fundingYear' | 'fundingAmount'> {
  // fundingYear + fundingAmount, checked with free counts.
  return { fundingYear: { min: fundedSinceYear(now) }, fundingAmount: { min: MIN_FUNDING_USD } };
}

export const growthSignal = (): string => `headcount +${GROWTH_MIN * 100}% or more in 6 months`;
export const fundingSignal = (now: Date): string => `latest round in ${fundedSinceYear(now)} or later, $${MIN_FUNDING_USD / 1_000_000}M+ raised`;

export function tierSignals(tier: Tier, now: Date): string[] {
  if (tier === 1) return [growthSignal(), fundingSignal(now)];
  if (tier === 2) return [growthSignal()];
  return [];
}

export function describeTier(tier: Tier, now: Date): string {
  if (tier === 1) return `Growing and recently funded: ${growthSignal()}, ${fundingSignal(now)}`;
  if (tier === 2) return `Growing only: ${growthSignal()}, not in tier 1`;
  return 'The rest of the market';
}

/**
 * Tier 1 and 2 are expressed as filters. Tiers are disjoint because they are filled in order with
 * `domain: {notIn}`: once tier 1 is drained, "growing and not fetched" is exactly tier 2, and once
 * tier 2 is drained, "target and not fetched" is exactly tier 3.
 */
export function tierFilters(target: CompanyFilter, now: Date): Record<Tier, CompanyFilter> {
  const growing = { ...target, workforceGrowth: GROWTH_FILTER };
  return { 1: { ...growing, ...fundingFilter(now) }, 2: growing, 3: target };
}

export interface TierSizes {
  1: number;
  2: number;
  3: number;
  /** Growing, with or without funding (tiers 1 + 2). */
  growing: number;
  /** Recently funded, with or without growth. Context only. */
  funded: number;
}

/** Free counts for each tier. `targets` is the size of the whole market from the sizing step. */
export async function sizeTiers(client: CompanyEnrich, target: CompanyFilter, targets: number, now: Date): Promise<TierSizes> {
  const filters = tierFilters(target, now);
  const [tier1 = 0, growing = 0, funded = 0] = await countCompanies(client, [filters[1], filters[2], { ...target, ...fundingFilter(now) }]);
  return { 1: tier1, 2: Math.max(0, growing - tier1), 3: Math.max(0, targets - growing), growing, funded };
}

export interface AccountPlan {
  filters: Record<Tier, CompanyFilter>;
  sizes: TierSizes;
  accounts: number;
  withFunding: boolean;
  now: Date;
}

/** How many accounts each tier will contribute: tier 1 first, then 2, then 3. */
export function allocateAccounts(accounts: number, sizes: TierSizes): Record<Tier, number> {
  const allocation: Record<Tier, number> = { 1: 0, 2: 0, 3: 0 };
  let left = accounts;
  for (const tier of TIERS) {
    allocation[tier] = Math.min(left, sizes[tier]);
    left -= allocation[tier];
  }
  return allocation;
}

const creditsPerAccount = (withFunding: boolean) => COST.company + (withFunding ? COST.expansion : 0);

export function estimateAccounts(plan: Omit<AccountPlan, 'filters' | 'now'>): CostLine {
  const allocation = allocateAccounts(plan.accounts, plan.sizes);
  const total = allocation[1] + allocation[2] + allocation[3];
  const detail = `${total} companies x ${creditsPerAccount(plan.withFunding)} (${TIERS.map((tier) => `tier ${tier}: ${allocation[tier]}`).join(', ')})`;
  return { step: 'accounts', detail, credits: total * creditsPerAccount(plan.withFunding) };
}

/**
 * Paid: one filter search per tier that has room, best tier first. Each search excludes the
 * domains already fetched, so no company is billed twice and the tiers stay disjoint. If a tier
 * returns fewer companies than its count promised, the next tier makes up the difference, but the
 * step never spends more than `estimateAccounts`, which is what the budget check approved.
 *
 * Each page is appended to `accounts` as soon as it arrives, so if a later search fails the
 * companies already paid for are still in the caller's run record.
 */
export async function fillAccounts(client: CompanyEnrich, plan: AccountPlan, ledger: CreditLedger, log: Log, accounts: Account[]): Promise<void> {
  const perAccount = creditsPerAccount(plan.withFunding);
  const expand: CompanyExpansion[] = plan.withFunding ? ['financial'] : [];
  let budget = estimateAccounts(plan).credits;

  for (const tier of TIERS) {
    const pageSize = Math.min(plan.accounts - accounts.length, plan.sizes[tier], Math.floor(budget / perAccount));
    if (pageSize <= 0) continue;

    const fetched = accounts.map((account) => account.company.domain);
    const filter = excludeDomains(plan.filters[tier], fetched);
    const page = await client.companies.search({ filter, pageSize, ...(expand.length > 0 && { expand }) });

    const charged = searchCharge(page.items.length, COST.company, perAccount - COST.company);
    budget -= charged;
    ledger.record('accounts', `tier ${tier}: ${page.items.length} of ${pageSize} companies`, pageSize * perAccount, charged);
    log(`   tier ${tier}: ${page.items.length} companies (${charged} credits): ${page.items.map((company) => company.domain).join(', ')}`);

    for (const company of page.items) {
      if (fetched.includes(company.domain)) continue; // defensive: notIn should already prevent this
      accounts.push({ rank: accounts.length + 1, tier, signals: tierSignals(tier, plan.now), company });
    }
  }
}
