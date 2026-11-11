/**
 * Turns MCP tool results into small, flat rows.
 *
 * The MCP server returns full API records (a company is about 6 KB with keywords,
 * technologies and coordinates). Slack messages, CSV files and Claude's context only
 * need a few fields, so everything downstream works with these rows instead.
 */

export interface CompanyRow {
  name?: string;
  domain?: string;
  industry?: string;
  employees?: string;
  revenue?: string;
  foundedYear?: number;
  city?: string;
  country?: string;
  type?: string;
  fundingStage?: string;
  totalFunding?: number;
  linkedinUrl?: string;
  logoUrl?: string;
  description?: string;
  /** Similarity score from a lookalike search. Not a probability. */
  score?: number;
}

export interface PersonRow {
  id?: string;
  name?: string;
  position?: string;
  seniority?: string;
  department?: string;
  country?: string;
  company?: string;
  companyDomain?: string;
  linkedinUrl?: string;
}

export interface Rows {
  companies: CompanyRow[];
  people: PersonRow[];
}

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value || value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

function withoutEmpty<T extends object>(row: T): T {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as T;
}

export function companyRow(raw: unknown, score?: number): CompanyRow {
  const company = record(raw);
  const location = record(company.location);
  const financial = record(company.financial);
  const socials = record(company.socials);
  return withoutEmpty({
    name: text(company.name),
    domain: text(company.domain),
    industry: text(company.industry),
    employees: text(company.employees),
    revenue: text(company.revenue),
    foundedYear: num(company.founded_year),
    city: text(record(location.city).name),
    country: text(record(location.country).name),
    type: text(company.type),
    fundingStage: text(financial.funding_stage),
    totalFunding: num(financial.total_funding),
    linkedinUrl: text(socials.linkedin_url),
    logoUrl: text(company.logo_url),
    description: truncate(text(company.description), 300),
    score,
  });
}

export function personRow(raw: unknown): PersonRow {
  const person = record(raw);
  const current = list(person.experiences).map(record).find((experience) => experience.isCurrent === true);
  const company = record(current?.company);
  return withoutEmpty({
    id: text(person.id),
    name: text(person.name),
    position: text(person.position),
    seniority: text(person.seniority),
    department: text(person.department),
    country: text(record(record(person.location).country).name),
    company: text(company.name),
    companyDomain: text(company.domain),
    linkedinUrl: text(record(person.socials).linkedin_url),
  });
}

/** Rows contained in one tool result, by tool name. */
export function rowsFromResult(toolName: string, structured: Json | undefined): Rows {
  const data = structured ?? {};
  switch (toolName) {
    case 'enrich_company':
    case 'get_company_by_id':
    case 'enrich_company_by_properties':
      return { companies: [companyRow(data)], people: [] };
    case 'search_companies':
      return { companies: list(data.items).map((item) => companyRow(item)), people: [] };
    case 'find_similar_companies': {
      const scores = record(record(data.metadata).scores);
      return {
        companies: list(data.items).map((item) => companyRow(item, num(scores[String(record(item).id)]))),
        people: [],
      };
    }
    case 'search_people':
      return { companies: [], people: list(data.items).map(personRow) };
    case 'get_person_by_id':
      return { companies: [], people: [personRow(data)] };
    default:
      return { companies: [], people: [] };
  }
}

/** A compact JSON version of a tool result for Claude: rows instead of full records. */
export function compactForModel(toolName: string, structured: Json | undefined): Json {
  const data = structured ?? {};
  const creditsCharged = num(record(data.creditInfo).cost);
  const { companies, people } = rowsFromResult(toolName, data);
  const forModel = (row: CompanyRow): CompanyRow => withoutEmpty({ ...row, logoUrl: undefined });
  const paging = withoutEmpty({ page: num(data.page), totalPages: num(data.totalPages), totalItems: num(data.totalItems) });

  switch (toolName) {
    case 'enrich_company':
    case 'get_company_by_id':
    case 'enrich_company_by_properties':
      return withoutEmpty({ company: companies[0] && forModel(companies[0]), creditsCharged });
    case 'search_companies':
    case 'find_similar_companies':
      return withoutEmpty({ ...paging, companies: companies.map(forModel), creditsCharged });
    case 'search_people':
      return withoutEmpty({ ...paging, people, creditsCharged });
    case 'get_person_by_id':
      return withoutEmpty({ person: people[0], creditsCharged });
    default:
      return data;
  }
}

/** Append rows, skipping companies and people already present. */
export function mergeRows(target: Rows, extra: Rows): void {
  const domains = new Set(target.companies.map((row) => row.domain ?? row.name));
  for (const row of extra.companies) {
    const key = row.domain ?? row.name;
    if (!domains.has(key)) {
      domains.add(key);
      target.companies.push(row);
    }
  }
  const people = new Set(target.people.map((row) => row.id ?? row.linkedinUrl ?? row.name));
  for (const row of extra.people) {
    const key = row.id ?? row.linkedinUrl ?? row.name;
    if (!people.has(key)) {
      people.add(key);
      target.people.push(row);
    }
  }
}
