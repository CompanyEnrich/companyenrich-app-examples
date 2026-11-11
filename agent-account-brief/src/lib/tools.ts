import {
  BadRequestError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  type CompanyEnrich,
  type CompanyExpansion,
  type PersonSearchParams,
  type RequestOptions,
} from '@companyenrich/sdk';
import type { CreditBudget, LedgerEntry } from './budget';
import { InputError, normalizeDomain } from './input';
import {
  compactCompany,
  compactLookalike,
  compactPerson,
  compactWorkforce,
  type CompanyFacts,
  type LookalikeFacts,
  type PersonFacts,
  type WorkforceFacts,
} from './projections';

/** Published v2 prices in credits. See https://docs.companyenrich.com */
export const PRICES = {
  companyEnrich: 1,
  expansion: 1,
  workforcePage: 1,
  personResult: 2,
  lookalikeResult: 5,
  personEnrich: 5,
} as const;

/** Upper bound on results per search, so one tool call can never cost more than 5 results. */
export const MAX_RESULTS = 5;

export const SENIORITIES = [
  'owner', 'founder', 'c-suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern',
] as const;

/** Root departments. A root matches all of its sub-departments. */
export const DEPARTMENTS = [
  'c-suite', 'product-management', 'engineering-technical', 'design', 'education', 'finance', 'human-resources',
  'information-technology', 'legal', 'marketing', 'medical-health', 'operations', 'sales', 'consulting',
] as const;

export type Seniority = (typeof SENIORITIES)[number];
export type Department = (typeof DEPARTMENTS)[number];
export type ToolName = 'enrich_company' | 'get_workforce' | 'find_people' | 'find_lookalikes' | 'lookup_person_by_email';

/** A successful tool call, kept so the brief can cite where each field came from. */
export interface ToolCallRecord {
  tool: ToolName;
  endpoint: string;
  args: string;
  retrievedAt: string;
  result: object;
}

export interface ToolContext {
  client: CompanyEnrich;
  budget: CreditBudget;
  /** When true, tools run their free checks and reserve credits, but never call a paid endpoint. */
  dryRun: boolean;
  calls: ToolCallRecord[];
  now: () => Date;
  log: (line: string) => void;
}

export type ToolOutcome<T> =
  | { status: 'ok'; data: T & { retrievedAt: string } }
  | { status: 'dry-run'; credits: number; note?: string }
  | { status: 'error'; error: string };

export interface EnrichCompanyResult { company: CompanyFacts }
export interface WorkforceResult { workforce: WorkforceFacts }
export interface FindPeopleResult { matched: number; people: PersonFacts[] }
export interface LookalikesResult { matched: number; lookalikes: LookalikeFacts[] }
export interface PersonLookupResult { person: PersonFacts }

export function createToolContext(options: {
  client: CompanyEnrich;
  budget: CreditBudget;
  dryRun?: boolean;
  now?: () => Date;
  log?: (line: string) => void;
}): ToolContext {
  return {
    client: options.client,
    budget: options.budget,
    dryRun: options.dryRun ?? false,
    calls: [],
    now: options.now ?? (() => new Date()),
    log: options.log ?? (() => {}),
  };
}

/** companies.enrich, optionally with the paid `financial` and `technologies` expansions. */
export async function enrichCompany(
  ctx: ToolContext,
  input: { domain: string; includeFunding?: boolean; includeTech?: boolean },
): Promise<ToolOutcome<EnrichCompanyResult>> {
  const domain = parseDomain(input.domain);
  if (!domain) return invalidDomain(input.domain);

  const expand: CompanyExpansion[] = [];
  if (input.includeFunding) expand.push('financial');
  if (input.includeTech) expand.push('technologies');
  const args = [domain, ...expand.map((expansion) => `+${expansion}`)].join(' ');
  const cost = PRICES.companyEnrich + expand.length * PRICES.expansion;

  if (ctx.dryRun) {
    const note = (await isKnownDomain(ctx, domain))
      ? undefined
      : `${domain} is not stored yet; a live run tries on-demand enrichment (free if nothing is found)`;
    return dryRun(ctx, 'enrich_company', args, cost, note);
  }

  const hold = reserve(ctx, 'enrich_company', args, cost);
  if (!hold.ok) return hold.outcome;
  try {
    const params = { domain, ...(expand.length > 0 ? { expand } : {}) };
    const company = await sendPaidGet((options) => ctx.client.companies.enrich(params, options));
    ctx.budget.settle(hold.entry, cost);
    return success(ctx, 'enrich_company', 'GET /v2/companies/enrich', args, { company: compactCompany(company) });
  } catch (error) {
    return recover(ctx, 'enrich_company', hold.entry, error, `no company found for ${domain}`);
  }
}

/** companies.workforce: observed headcount, department mix and 12-month change. */
export async function getWorkforce(ctx: ToolContext, input: { domain: string }): Promise<ToolOutcome<WorkforceResult>> {
  const domain = parseDomain(input.domain);
  if (!domain) return invalidDomain(input.domain);
  if (ctx.dryRun) return dryRun(ctx, 'get_workforce', domain, PRICES.workforcePage);

  const hold = reserve(ctx, 'get_workforce', domain, PRICES.workforcePage);
  if (!hold.ok) return hold.outcome;
  try {
    const workforce = await sendPaidGet((options) => ctx.client.companies.workforce({ domain }, options));
    ctx.budget.settle(hold.entry, PRICES.workforcePage);
    return success(ctx, 'get_workforce', 'GET /v2/companies/workforce', domain, {
      workforce: compactWorkforce(workforce),
    });
  } catch (error) {
    return recover(ctx, 'get_workforce', hold.entry, error, `no workforce data for ${domain}`);
  }
}

export interface FindPeopleInput {
  domain: string;
  seniority?: Seniority[];
  department?: Department[];
  /** Departments to leave out, so two calls never pay for the same person twice. */
  excludeDepartment?: Department[];
  position?: string[];
  limit?: number;
}

/** Free people.count first; the paid people.search runs only when something matched. */
export async function findPeople(ctx: ToolContext, input: FindPeopleInput): Promise<ToolOutcome<FindPeopleResult>> {
  const domain = parseDomain(input.domain);
  if (!domain) return invalidDomain(input.domain);
  const limit = clampLimit(input.limit);
  const filter = peopleFilter(domain, input);
  let args = describePeopleQuery(domain, input, limit);

  let entry: LedgerEntry | undefined;
  try {
    const { count } = await ctx.client.people.count({ filter });
    const take = Math.min(count, limit);
    args += ` · ${count} matched`;
    if (take === 0) {
      ctx.budget.recordFree('find_people', `${args}, paid search skipped`);
      ctx.log(`find_people ${args}, paid search skipped`);
      return success(ctx, 'find_people', 'POST /v2/people/search/count', args, { matched: 0, people: [] });
    }

    const cost = take * PRICES.personResult;
    if (ctx.dryRun) return dryRun(ctx, 'find_people', args, cost);
    const hold = reserve(ctx, 'find_people', args, cost);
    if (!hold.ok) return hold.outcome;
    entry = hold.entry;
    const page = await ctx.client.people.search({ filter, pageSize: take });
    // An empty paid page still bills one result.
    ctx.budget.settle(entry, Math.max(page.items.length, 1) * PRICES.personResult);
    const now = ctx.now();
    return success(ctx, 'find_people', 'POST /v2/people/search', args, {
      matched: count,
      people: page.items.map((person) => compactPerson(person, domain, now)),
    });
  } catch (error) {
    return recover(ctx, 'find_people', entry, error, `no people found at ${domain}`);
  }
}

/** Free companies.count with `lookalike` first, then the paid search. Keeps the API's order and scores. */
export async function findLookalikes(
  ctx: ToolContext,
  input: { domain: string; limit?: number },
): Promise<ToolOutcome<LookalikesResult>> {
  const domain = parseDomain(input.domain);
  if (!domain) return invalidDomain(input.domain);
  const limit = clampLimit(input.limit);
  let args = `${domain} limit=${limit}`;

  // A seed the dataset does not know can make the lookalike query wait on enrichment; check for free first.
  if (!(await isKnownDomain(ctx, domain))) {
    ctx.budget.recordFree('find_lookalikes', `${args} · seed not in dataset`);
    return { status: 'error', error: `${domain} is not in the CompanyEnrich dataset, so it cannot seed a lookalike search` };
  }

  const query = { lookalike: { domains: [domain] } };
  let entry: LedgerEntry | undefined;
  try {
    const { count } = await ctx.client.companies.count(query);
    const take = Math.min(count, limit);
    args += ` · ${count} matched`;
    if (take === 0) {
      ctx.budget.recordFree('find_lookalikes', `${args}, paid search skipped`);
      ctx.log(`find_lookalikes ${args}, paid search skipped`);
      return success(ctx, 'find_lookalikes', 'POST /v2/companies/search/count', args, { matched: 0, lookalikes: [] });
    }

    const cost = take * PRICES.lookalikeResult;
    if (ctx.dryRun) return dryRun(ctx, 'find_lookalikes', args, cost);
    const hold = reserve(ctx, 'find_lookalikes', args, cost);
    if (!hold.ok) return hold.outcome;
    entry = hold.entry;
    const page = await ctx.client.companies.search({ ...query, pageSize: take });
    ctx.budget.settle(entry, Math.max(page.items.length, 1) * PRICES.lookalikeResult);
    return success(ctx, 'find_lookalikes', 'POST /v2/companies/search', args, {
      matched: count,
      lookalikes: page.items.map((company) => compactLookalike(company, page.scores?.[company.id])),
    });
  } catch (error) {
    return recover(ctx, 'find_lookalikes', entry, error, `no lookalikes found for ${domain}`);
  }
}

/** people.enrich: reverse lookup of a work email. 5 credits when a person is found. */
export async function lookupPersonByEmail(
  ctx: ToolContext,
  input: { email: string },
): Promise<ToolOutcome<PersonLookupResult>> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 'error', error: `"${input.email}" is not an email address` };
  if (ctx.dryRun) return dryRun(ctx, 'lookup_person_by_email', email, PRICES.personEnrich);

  const hold = reserve(ctx, 'lookup_person_by_email', email, PRICES.personEnrich);
  if (!hold.ok) return hold.outcome;
  try {
    const person = await ctx.client.people.enrich({ email });
    ctx.budget.settle(hold.entry, PRICES.personEnrich);
    return success(ctx, 'lookup_person_by_email', 'POST /v2/people/enrich', email, {
      person: compactPerson(person, undefined, ctx.now()),
    });
  } catch (error) {
    return recover(ctx, 'lookup_person_by_email', hold.entry, error, 'no person found for that email');
  }
}

/** The domain of the person's current company, as returned by lookup_person_by_email. */
export function currentCompanyDomain(person: PersonFacts): string | undefined {
  return person.experiences.find((experience) => experience.company?.domain)?.company?.domain;
}

const RATE_LIMIT_RETRIES = 2;
const MAX_RATE_LIMIT_WAIT_MS = 10_000;

/**
 * Sends a paid GET once (`maxRetries: 0`), so one reservation always matches one request. A 429 is
 * never billed, so rate limits alone are retried here. (Paid POSTs are already sent once by the SDK.)
 */
async function sendPaidGet<T>(request: (options: RequestOptions) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request({ maxRetries: 0 });
    } catch (error) {
      if (!(error instanceof RateLimitError) || attempt >= RATE_LIMIT_RETRIES) throw error;
      const retryAfter = Number(error.headers.get('retry-after') ?? Number.NaN);
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, MAX_RATE_LIMIT_WAIT_MS)));
    }
  }
}

type Hold = { ok: true; entry: LedgerEntry } | { ok: false; outcome: { status: 'error'; error: string } };

function reserve(ctx: ToolContext, tool: ToolName, args: string, credits: number): Hold {
  const reservation = ctx.budget.reserve(tool, args, credits);
  if (!reservation.ok) {
    ctx.log(`${tool} ${args}: refused, ${reservation.error}`);
    return { ok: false, outcome: { status: 'error', error: reservation.error } };
  }
  ctx.log(`${tool} ${args}: reserved ${credits} credit${credits === 1 ? '' : 's'}`);
  return reservation;
}

/** In a dry run the reservation is still made, so the guard and the ledger behave exactly as in a live run. */
function dryRun(ctx: ToolContext, tool: ToolName, args: string, credits: number, note?: string) {
  const hold = reserve(ctx, tool, args, credits);
  if (!hold.ok) return hold.outcome;
  ctx.budget.settle(hold.entry, credits);
  if (note) ctx.log(`note: ${note}`);
  return { status: 'dry-run' as const, credits, ...(note ? { note } : {}) };
}

function success<T extends object>(
  ctx: ToolContext,
  tool: ToolName,
  endpoint: string,
  args: string,
  result: T,
): ToolOutcome<T> {
  const data = { ...result, retrievedAt: ctx.now().toISOString() };
  ctx.calls.push({ tool, endpoint, args, retrievedAt: data.retrievedAt, result: data });
  return { status: 'ok', data };
}

/**
 * Turns the errors a caller can act on (nothing found, a rejected argument) into an error result.
 * Those requests are not billed. Anything else (bad key, out of credits, network) is rethrown and stops the run.
 */
function recover(ctx: ToolContext, tool: ToolName, entry: LedgerEntry | undefined, error: unknown, notFound: string) {
  let message: string;
  if (error instanceof NotFoundError) {
    message = `${notFound} (not charged)`;
  } else if (error instanceof BadRequestError || error instanceof ValidationError) {
    message = `the API rejected the request: ${error.detail ?? error.title ?? error.message}`;
  } else {
    throw error;
  }
  if (entry) ctx.budget.settle(entry, 0);
  ctx.log(`${tool}: ${message}`);
  return { status: 'error' as const, error: message };
}

async function isKnownDomain(ctx: ToolContext, domain: string): Promise<boolean> {
  const { items } = await ctx.client.companies.autocomplete(domain);
  return items.some((item) => item.domain === domain);
}

type PersonFilter = NonNullable<PersonSearchParams['filter']>;

function peopleFilter(domain: string, input: FindPeopleInput): PersonFilter {
  const filter: PersonFilter = { domain };
  if (input.seniority?.length) filter.seniority = input.seniority;
  const include = input.department ?? [];
  const exclude = input.excludeDepartment ?? [];
  if (include.length > 0 && exclude.length > 0) filter.department = { in: include, notIn: exclude };
  else if (include.length > 0) filter.department = include;
  else if (exclude.length > 0) filter.department = { notIn: exclude };
  if (input.position?.length) filter.position = input.position;
  return filter;
}

function describePeopleQuery(domain: string, input: FindPeopleInput, limit: number): string {
  const parts = [domain];
  if (input.seniority?.length) parts.push(`seniority=${input.seniority.join(',')}`);
  if (input.department?.length) parts.push(`department=${input.department.join(',')}`);
  if (input.excludeDepartment?.length) parts.push(`not=${input.excludeDepartment.join(',')}`);
  if (input.position?.length) parts.push(`position=${input.position.join('|')}`);
  parts.push(`limit=${limit}`);
  return parts.join(' ');
}

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(limit ?? MAX_RESULTS)));
}

function parseDomain(raw: string): string | undefined {
  try {
    return normalizeDomain(raw);
  } catch (error) {
    if (error instanceof InputError) return undefined;
    throw error;
  }
}

function invalidDomain(raw: string) {
  return { status: 'error' as const, error: `"${raw}" is not a valid domain` };
}
