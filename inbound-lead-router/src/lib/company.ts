import type { Company, CompanyExpansion } from '@companyenrich/sdk';
import type { Category, EmployeeRange, RevenueRange } from './enums';

/**
 * The slice of a CompanyEnrich company that scoring, routing and alerts use.
 * It is what the cache stores and what the playground sends to the browser.
 *
 * `funding` and `technologies` come from paid expansions. `undefined` means the
 * expansion was not requested; `null` means it was requested and had no data.
 */
export interface CompanyFacts {
  id: string;
  name: string | null;
  domain: string;
  industry: string | null;
  type: string | null;
  employees: EmployeeRange | null;
  revenue: RevenueRange | null;
  categories: Category[];
  country: { code: string; name: string } | null;
  state: { code: string | null; name: string } | null;
  city: string | null;
  foundedYear: number | null;
  linkedinUrl: string | null;
  funding?: { stage: string | null; date: string | null; totalUsd: number | null } | null;
  technologies?: string[] | null;
}

export function toCompanyFacts(company: Company, expand: readonly CompanyExpansion[]): CompanyFacts {
  const location = company.location;
  const facts: CompanyFacts = {
    id: company.id,
    name: company.name ?? null,
    domain: company.domain,
    industry: company.industry ?? null,
    type: company.type ?? null,
    employees: company.employees ?? null,
    revenue: company.revenue ?? null,
    categories: company.categories ?? [],
    country: location?.country ? { code: location.country.code, name: location.country.name } : null,
    state: location?.state ? { code: location.state.code ?? null, name: location.state.name } : null,
    city: location?.city?.name ?? null,
    foundedYear: company.foundedYear ?? null,
    linkedinUrl: company.socials?.linkedinUrl ?? null,
  };
  if (expand.includes('financial')) {
    const financial = company.financial;
    facts.funding = financial
      ? {
          stage: financial.fundingStage ?? null,
          date: financial.fundingDate ?? null,
          totalUsd: financial.totalFunding ?? null,
        }
      : null;
  }
  if (expand.includes('technologies')) facts.technologies = company.technologies ?? null;
  return facts;
}
