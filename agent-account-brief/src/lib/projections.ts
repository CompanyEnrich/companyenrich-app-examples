import type { Company, CompanyWorkforce, Person } from '@companyenrich/sdk';

// Tool results are compact projections of API responses. They keep the API's
// field names and nesting, so a citation such as [company.financial.fundingStage]
// points at the same field in the API docs. Fields the API left empty are dropped,
// which keeps the model's context small and makes "not available" unambiguous.

export interface CompanyFacts {
  name?: string;
  domain: string;
  description?: string;
  type?: string;
  industry?: string;
  industries?: string[];
  categories?: string[];
  foundedYear?: number;
  employees?: string;
  revenue?: string;
  location?: {
    city?: { name: string };
    state?: { name: string };
    country?: { code: string; name: string };
  };
  financial?: {
    fundingStage?: string;
    fundingDate?: string;
    totalFunding?: number;
    stockSymbol?: string;
    stockExchange?: string;
    /** Up to 5, newest first. */
    fundingRounds?: FundingRound[];
    /** Derived: how many rounds the API returned, before the cap above. */
    fundingRoundsTotal?: number;
  };
  /** Up to 30, in API order. */
  technologies?: string[];
  /** Derived: how many technologies the API returned, before the cap above. */
  technologiesTotal?: number;
}

export interface FundingRound {
  date?: string;
  type?: string;
  amount?: string;
  investors?: string;
}

export interface WorkforceFacts {
  observedEmployeeCount: number;
  employeeCountRange?: string;
  unclassifiedHeadcount: number;
  historyFrom: string;
  historyTo: string;
  /** Non-zero departments, largest first. */
  departmentHeadcount: Record<string, number>;
  /** Derived: departmentHeadcount / observedEmployeeCount. */
  departmentShare: Record<string, number>;
  /** Derived from history: oldest vs newest monthly snapshot in the 12-month window. */
  change12m?: HeadcountChange;
  /** Derived from history: departments with at least 10 people at the start of the window. */
  departmentChange12m?: Record<string, { from: number; to: number; pct: number }>;
}

export interface HeadcountChange {
  fromDate: string;
  fromCount: number;
  toDate: string;
  toCount: number;
  pct: number;
}

export interface PersonFacts {
  id: number;
  name?: string;
  position?: string;
  seniority?: string;
  department?: string;
  socials?: { linkedinUrl?: string };
  /** Only the person's current role(s) at the company being researched. */
  experiences: ExperienceFacts[];
  /** Derived: years since experiences[0].startDate. */
  tenureYears?: number;
}

export interface ExperienceFacts {
  position?: string;
  seniority?: string;
  department?: string;
  startDate?: string;
  company?: { name?: string; domain?: string };
}

export interface LookalikeFacts {
  name?: string;
  domain: string;
  industry?: string;
  employees?: string;
  location?: { country?: { name: string } };
  /** From the search response's `scores` map. Ranks similarity; not a probability. */
  score?: number;
}

const MAX_DESCRIPTION = 600;
const MAX_TECHNOLOGIES = 30;
const MAX_FUNDING_ROUNDS = 5;
const MIN_DEPARTMENT_FOR_GROWTH = 10;

export function compactCompany(company: Company): CompanyFacts {
  const { location, financial } = company;
  return {
    name: value(company.name),
    domain: company.domain,
    description: truncate(value(company.description), MAX_DESCRIPTION),
    type: value(company.type),
    industry: value(company.industry),
    industries: list(company.industries),
    categories: list(company.categories),
    foundedYear: value(company.foundedYear),
    employees: value(company.employees),
    revenue: value(company.revenue),
    location: location
      ? nonEmpty({
          city: location.city ? { name: location.city.name } : undefined,
          state: location.state ? { name: location.state.name } : undefined,
          country: location.country ? { code: location.country.code, name: location.country.name } : undefined,
        })
      : undefined,
    financial: financial
      ? nonEmpty({
          fundingStage: value(financial.fundingStage),
          fundingDate: value(financial.fundingDate),
          totalFunding: value(financial.totalFunding),
          stockSymbol: value(financial.stockSymbol),
          stockExchange: value(financial.stockExchange),
          fundingRounds: list(
            (financial.fundingRounds ?? [])
              .map((round) => ({
                date: value(round.date),
                type: value(round.type),
                amount: value(round.amount),
                investors: value(round.investors),
              }))
              .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
              .slice(0, MAX_FUNDING_ROUNDS),
          ),
          fundingRoundsTotal: financial.fundingRounds?.length || undefined,
        })
      : undefined,
    technologies: list(company.technologies?.slice(0, MAX_TECHNOLOGIES)),
    technologiesTotal: company.technologies?.length || undefined,
  };
}

export function compactWorkforce(workforce: CompanyWorkforce): WorkforceFacts {
  const observed = workforce.observedEmployeeCount;
  const departmentHeadcount = nonZeroDescending(workforce.departmentHeadcount);
  const departmentShare = Object.fromEntries(
    Object.entries(departmentHeadcount).map(([department, count]) => [department, round(count / observed, 3)]),
  );
  return {
    observedEmployeeCount: observed,
    employeeCountRange: value(workforce.employeeCountRange),
    unclassifiedHeadcount: workforce.unclassifiedHeadcount,
    historyFrom: workforce.historyFrom,
    historyTo: workforce.historyTo,
    departmentHeadcount,
    departmentShare: observed > 0 ? departmentShare : {},
    ...headcountChanges(workforce.history ?? []),
  };
}

/** History is newest first; compare the oldest snapshot in the window with the newest. */
function headcountChanges(history: NonNullable<CompanyWorkforce['history']>): Pick<
  WorkforceFacts,
  'change12m' | 'departmentChange12m'
> {
  const newest = history[0];
  const oldest = history.at(-1);
  if (!newest || !oldest || newest === oldest || oldest.observedEmployeeCount === 0) return {};

  const departmentChange12m: Record<string, { from: number; to: number; pct: number }> = {};
  for (const [department, from] of Object.entries(oldest.departmentHeadcount)) {
    const to = newest.departmentHeadcount[department as keyof typeof newest.departmentHeadcount];
    if (typeof from === 'number' && typeof to === 'number' && from >= MIN_DEPARTMENT_FOR_GROWTH) {
      departmentChange12m[department] = { from, to, pct: round((to - from) / from, 3) };
    }
  }

  return {
    change12m: {
      fromDate: oldest.date,
      fromCount: oldest.observedEmployeeCount,
      toDate: newest.date,
      toCount: newest.observedEmployeeCount,
      pct: round((newest.observedEmployeeCount - oldest.observedEmployeeCount) / oldest.observedEmployeeCount, 3),
    },
    departmentChange12m: nonEmpty(departmentChange12m),
  };
}

/** `domain` limits experiences to the company being researched; without it, all current roles are kept. */
export function compactPerson(person: Person, domain: string | undefined, now: Date): PersonFacts {
  const current = person.experiences.filter((experience) => experience.isCurrent);
  const atCompany = domain ? current.filter((experience) => experience.company?.domain === domain) : [];
  const experiences = (atCompany.length > 0 ? atCompany : current).map((experience) => ({
    position: value(experience.position),
    seniority: value(experience.seniority),
    department: value(experience.department),
    startDate: value(experience.startDate),
    company: experience.company
      ? nonEmpty({ name: value(experience.company.name), domain: value(experience.company.domain) })
      : undefined,
  }));
  const startDate = experiences[0]?.startDate;
  return {
    id: person.id,
    name: value(person.name),
    position: value(person.position),
    seniority: value(person.seniority),
    department: value(person.department),
    socials: person.socials.linkedinUrl ? { linkedinUrl: person.socials.linkedinUrl } : undefined,
    experiences,
    tenureYears: startDate ? yearsBetween(startDate, now) : undefined,
  };
}

export function compactLookalike(company: Company, score: number | undefined): LookalikeFacts {
  return {
    name: value(company.name),
    domain: company.domain,
    industry: value(company.industry),
    employees: value(company.employees),
    location: company.location?.country ? { country: { name: company.location.country.name } } : undefined,
    score: score === undefined ? undefined : round(score, 3),
  };
}

function value<T>(input: T | null | undefined): T | undefined {
  return input ?? undefined;
}

function list<T>(input: T[] | null | undefined): T[] | undefined {
  return input && input.length > 0 ? input : undefined;
}

/** Returns undefined for an object whose fields are all undefined. */
function nonEmpty<T extends object>(input: T): T | undefined {
  return Object.values(input).some((field) => field !== undefined) ? input : undefined;
}

function truncate(text: string | undefined, max: number): string | undefined {
  return text && text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function nonZeroDescending(headcount: object): Record<string, number> {
  return Object.fromEntries(
    Object.entries(headcount)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
      .sort((a, b) => b[1] - a[1]),
  );
}

function round(input: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(input * factor) / factor;
}

function yearsBetween(isoDate: string, now: Date): number | undefined {
  const start = Date.parse(isoDate);
  if (Number.isNaN(start)) return undefined;
  return round((now.getTime() - start) / (365.25 * 24 * 3600 * 1000), 1);
}
