import type { Company, CompanySearchQuery } from '@companyenrich/sdk';
import type { CompanySearchFilter, NewCompaniesConfig } from '../config.js';
import { CREDITS, searchCharge } from '../credits.js';
import type { Signal } from '../digest.js';
import { normalizeDomain, websiteUrl } from '../domains.js';
import { formatStage, formatUsd, plural } from '../format.js';
import type { NewCompaniesState } from '../state.js';
import type { WatcherContext, WatcherPlan } from './types.js';

/** Most domains sent in one `notIn` rule. Older seen domains are filtered out locally instead. */
export const NOT_IN_LIMIT = 2500;
/** Seen domains kept in state per watcher. The oldest drop off first. */
const MAX_STORED_DOMAINS = 20_000;

/**
 * Companies that newly match a saved query. The free count, with every recently reported
 * domain excluded, says whether anything is new before a paid search runs.
 */
export async function planNewCompanies(
  ctx: WatcherContext,
  watcher: NewCompaniesConfig,
  previous: NewCompaniesState | undefined,
): Promise<WatcherPlan> {
  const seen = previous?.seenDomains ?? [];
  const query = buildCompanyQuery(watcher, seen);
  const { count } = await ctx.client.companies.count(query);

  const basePrice = watcher.query.semantic ? CREDITS.companySemanticResult : CREDITS.companyFilterResult;
  const unitCost = basePrice + watcher.expand.length * CREDITS.expansion;

  return {
    finding: count === 0 ? 'no new matches' : plural(count, 'new match', 'new matches'),
    unit: ['company', 'companies'],
    unitCost,
    units: Math.min(count, watcher.maxResultsPerRun),
    async execute(granted) {
      const nextState = (seenDomains: string[]): NewCompaniesState => ({
        type: 'new-companies',
        lastRunAt: ctx.now.toISOString(),
        seenDomains,
      });
      if (granted === 0) return { signals: [], notes: [], creditsCharged: 0, nextState: nextState(seen) };

      const page = await ctx.client.companies.search({
        ...query,
        pageSize: granted,
        ...(watcher.expand.length > 0 && { expand: watcher.expand }),
      });

      const known = new Set(seen);
      const fresh = page.items.filter((company) => {
        const domain = normalizeDomain(company.domain);
        if (known.has(domain)) return false;
        known.add(domain);
        return true;
      });

      const notes: string[] = [];
      const skipped = page.items.length - fresh.length;
      if (skipped > 0) notes.push(`Skipped ${plural(skipped, 'company', 'companies')} already reported.`);
      const remaining = count - page.items.length;
      if (remaining > 0) notes.push(`${plural(remaining, 'more match', 'more matches')} will be picked up on later runs.`);

      return {
        signals: fresh.map(companySignal),
        notes,
        creditsCharged: searchCharge(page.items.length, basePrice, watcher.expand.length),
        nextState: nextState([...seen, ...fresh.map((company) => normalizeDomain(company.domain))].slice(-MAX_STORED_DOMAINS)),
      };
    },
  };
}

export function buildCompanyQuery(watcher: NewCompaniesConfig, seenDomains: readonly string[]): CompanySearchQuery {
  const filter = excludeSeenDomains(watcher.query.filter as CompanySearchFilter | undefined, seenDomains);
  return {
    ...(filter && { filter }),
    ...(watcher.query.semantic && { semantic: watcher.query.semantic }),
  };
}

/**
 * Adds the most recently seen domains to the filter's `domain.notIn` rule, keeping any
 * domain rule from the config (for example excluded customers). Capped at NOT_IN_LIMIT.
 */
export function excludeSeenDomains(
  filter: CompanySearchFilter | undefined,
  seen: readonly string[],
): CompanySearchFilter | undefined {
  if (seen.length === 0) return filter;

  const rule = filter?.domain;
  const configured =
    rule === undefined || rule === null
      ? {}
      : typeof rule === 'string'
        ? { in: [rule] }
        : Array.isArray(rule)
          ? { in: rule }
          : rule;
  const configuredNotIn = configured.notIn ?? [];
  const room = Math.max(0, NOT_IN_LIMIT - configuredNotIn.length);
  const recent = room > 0 ? seen.slice(-room) : [];
  return { ...filter, domain: { ...configured, notIn: [...configuredNotIn, ...recent] } };
}

function companySignal(company: Company): Signal {
  const domain = normalizeDomain(company.domain);
  return {
    title: company.name ?? domain,
    domain,
    summary: describeCompany(company),
    details: [],
    link: { label: domain, url: websiteUrl(domain) },
  };
}

function describeCompany(company: Company): string {
  const parts: string[] = [];
  const financial = company.financial;
  if (financial?.fundingStage || financial?.fundingDate) {
    const stage = formatStage(financial.fundingStage) ?? 'Funding';
    parts.push(financial.fundingDate ? `${stage} on ${financial.fundingDate.slice(0, 10)}` : stage);
  }
  if (financial?.totalFunding) parts.push(`${formatUsd(financial.totalFunding)} raised in total`);
  if (company.industry) parts.push(company.industry);
  if (company.employees) parts.push(`${company.employees} employees`);
  const place = [company.location?.city?.name, company.location?.country?.code].filter(Boolean).join(', ');
  if (place) parts.push(place);
  return parts.join(' · ') || 'Newly matches the query';
}
