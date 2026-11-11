import { NotFoundError, type CompanyEnrich, type CompanySearchCount, type CompanySearchQuery, type PersonSearchQuery } from '@companyenrich/sdk';
import { buildCompanyQuery, checkTechnologies, describeEnvironment, formatFilter, SEMANTIC_COMPANY_LIMIT, type EnvironmentInput } from './company-query.js';
import { groupByCompany, rankCompanies, type CompanyRow } from './companies.js';
import { mapLimit, MAX_CONCURRENCY } from './concurrency.js';
import { COST, CreditLedger, estimatePaidSteps, printEstimate, searchCharge, shortlistSize, type CostLine, type LedgerEntry } from './credits.js';
import { UsageError } from './errors.js';
import { headcountKeys, MIN_DEPARTMENT_COVERAGE, personFilter, resolveRole, rootDepartment, type RoleSelection } from './roles.js';
import { mergeDuplicates, toCandidate, type Candidate } from './shortlist.js';
import { retryOnRateLimit } from './retry.js';
import { tenureCutoff } from './tenure.js';
import { teamTrend } from './trends.js';
import { SENIORITIES, type Department, type Log, type PersonFilter, type Seniority } from './types.js';

export interface TalentMapOptions {
  /** Title phrases, e.g. ["data engineer"]. A person matches if their current title contains any of them. */
  roles: string[];
  seniority: Seniority[];
  environment: EnvironmentInput;
  minTenureYears?: number;
  people: number;
  trendTop: number;
  maxCredits: number;
  dryRun: boolean;
}

export interface TalentMapDeps {
  client: CompanyEnrich;
  log: Log;
  now?: Date;
}

export interface SeniorityCount {
  seniority: Seniority;
  people: number;
  selected: boolean;
}

export interface TalentMap {
  generatedAt: string;
  /** `stopped`: a paid step failed or hit the cap; whatever was already paid for is kept. */
  status: 'complete' | 'dry-run' | 'no-matches' | 'stopped';
  stoppedBecause?: string;
  options: TalentMapOptions;
  role: RoleSelection & {
    /** Share of people with these titles that the department filter keeps. */
    departmentCoverage?: number;
    droppedDepartments: Department[];
    /** What the team trend measures, e.g. "engineering-technical" or "whole company". */
    trendScope: string;
  };
  environment: {
    description: string;
    query?: CompanySearchQuery;
    companies?: { count: number; total: number };
    inferred?: CompanySearchCount['interpretation'];
  };
  sizing: {
    /** People whose current title contains the role phrases. */
    withTitle: number;
    /** ...and in the role's department, at any company. */
    market: number;
    /** ...at companies matching the environment. */
    inEnvironment: number;
    bySeniority: SeniorityCount[];
    /** People in the environment without a seniority level. */
    unclassified: number;
    /** ...at the chosen seniority levels. */
    selected: number;
    /** ...and with the minimum tenure: the pool the shortlist is drawn from. */
    target: number;
    /** `target` limited to what the plan can return. */
    targetAccessible: number;
    joinedBefore?: string;
  };
  companies: CompanyRow[];
  shortlist: Candidate[];
  credits: {
    maxCredits: number;
    estimate: CostLine[];
    spent: number;
    entries: LedgerEntry[];
    balanceBefore?: number;
    balanceAfter?: number;
  };
  notes: string[];
}

/** Thrown when a paid step fails or would pass the cap. `map` holds the free sizing and any paid results. */
export class RunStoppedError extends Error {
  override name = 'RunStoppedError';

  constructor(
    readonly map: TalentMap,
    override readonly cause: unknown,
  ) {
    super(`Run stopped: ${map.stoppedBecause}`);
  }
}

const format = (value: number) => value.toLocaleString('en-US');

async function balance(client: CompanyEnrich): Promise<number> {
  const { credits } = await client.me();
  return credits.total - credits.used;
}

/** The closing balance is informational: failing to read it must not lose results already paid for. */
async function balanceIfAvailable(client: CompanyEnrich): Promise<number | undefined> {
  return balance(client).catch(() => undefined);
}

/** Step 1: validate the title phrases and pick the department filter, checking it with free counts. */
async function mapRole(client: CompanyEnrich, roles: string[], log: Log) {
  const suggestions = new Map(
    await mapLimit(roles, MAX_CONCURRENCY, async (phrase) => [phrase, (await client.positions.autocomplete(phrase)).items] as const),
  );
  let role = resolveRole(roles, suggestions);
  for (const check of role.checks) {
    const examples = check.suggestions.length > 0 ? `similar titles include ${check.suggestions.slice(0, 4).join(', ')}` : 'no similar titles';
    log(`  "${check.phrase}": ${check.known ? 'known title' : 'not an exact title'}; ${examples} -> ${check.department ?? 'no department mapped'}`);
  }

  const withTitle = await client.people.count({ filter: { position: role.titles } });
  if (withTitle.total === 0) {
    const ideas = role.checks.flatMap((check) => check.suggestions).slice(0, 5);
    throw new UsageError(`No profile has a current title containing ${roles.map((phrase) => `"${phrase}"`).join(' or ')}.${ideas.length > 0 ? ` Try: ${ideas.join(', ')}.` : ''}`);
  }

  // The department filter trims titles filed elsewhere ("data engineer" in IT, say) and sets the team
  // the trend step measures. Keep it only if it keeps most people with these titles.
  let market = withTitle;
  let departmentCoverage: number | undefined;
  let droppedDepartments: Department[] = [];
  if (role.departments.length > 0) {
    const withDepartment = await client.people.count({ filter: personFilter(role) });
    departmentCoverage = withDepartment.total / withTitle.total;
    log(`  Department ${role.departments.join(', ')} keeps ${Math.round(departmentCoverage * 100)}% of the ${format(withTitle.total)} people with these titles`);
    if (departmentCoverage >= MIN_DEPARTMENT_COVERAGE) {
      market = withDepartment;
    } else {
      log('  Dropping the department filter: it would hide most matching titles.');
      droppedDepartments = role.departments;
      role = { ...role, departments: [] };
    }
  }
  const roots = [...new Set(role.departments.map(rootDepartment))];
  const trendScope = roots.length > 0 ? roots.join(' + ') : 'whole company';
  return {
    role: { ...role, ...(departmentCoverage !== undefined ? { departmentCoverage } : {}), droppedDepartments, trendScope },
    withTitle: withTitle.total,
    market,
  };
}

/** Step 2: check the technologies, build the company query and count matching companies for free. */
async function mapEnvironment(client: CompanyEnrich, input: EnvironmentInput, log: Log): Promise<TalentMap['environment']> {
  const suggestions = new Map(
    await mapLimit(input.technologies, MAX_CONCURRENCY, async (name) => [name, (await client.technologies.autocomplete(name)).items] as const),
  );
  const technologies = checkTechnologies(input.technologies, suggestions);
  const [unknown] = technologies.unknown;
  if (unknown) {
    // Dropping it would silently widen the paid search, so stop before anything is spent.
    const ideas = unknown.suggestions.length > 0 ? ` Did you mean ${unknown.suggestions.slice(0, 3).join(', ')}?` : '';
    throw new UsageError(`Unknown technology "${unknown.name}": it is not in the CompanyEnrich technology list.${ideas} Remove it from --technologies.`);
  }
  const environment = { ...input, technologies: technologies.known };
  const description = describeEnvironment(environment);
  const query = buildCompanyQuery(environment);
  log(`  Environment: ${description}`);
  if (!query) return { description };

  const { count, total, interpretation } = await client.companies.count(query);
  log(
    query.semantic
      ? `  ${format(total)} companies in the semantic candidate pool; people search uses the ${format(Math.min(total, SEMANTIC_COMPANY_LIMIT))} best matches`
      : `  ${format(total)} ${total === 1 ? 'company matches' : 'companies match'}`,
  );
  if (interpretation?.filter) log(`  Inferred from the description: ${formatFilter(interpretation.filter)}`);
  return {
    description,
    query,
    companies: { count, total },
    ...(interpretation ? { inferred: interpretation } : {}),
  };
}

/** Builds the talent map: free sizing first, then (unless --dry-run) the paid shortlist and team trends. */
export async function buildTalentMap(options: TalentMapOptions, deps: TalentMapDeps): Promise<TalentMap> {
  const { client, log } = deps;
  const now = deps.now ?? new Date();
  const ledger = new CreditLedger(options.maxCredits);
  const balanceBefore = await balance(client);

  log('1. Role (free)');
  const { role, withTitle, market } = await mapRole(client, options.roles, log);
  log(`  ${format(market.total)} people in this role across all companies`);

  log('2. Company environment (free)');
  const environment = await mapEnvironment(client, options.environment, log);
  const company: Pick<PersonSearchQuery, 'company'> = environment.query ? { company: environment.query } : {};

  log('3. Pool size (free)');
  const inEnvironment = environment.query ? await client.people.count({ filter: personFilter(role), ...company }) : market;
  const seniorityTotals = await mapLimit(SENIORITIES, MAX_CONCURRENCY, async (seniority) => {
    const { total } = await client.people.count({ filter: personFilter(role, { seniority: [seniority] }), ...company });
    return { seniority, people: total, selected: options.seniority.includes(seniority) };
  });
  const classified = seniorityTotals.reduce((sum, row) => sum + row.people, 0);
  const selected =
    options.seniority.length > 0 ? seniorityTotals.filter((row) => row.selected).reduce((sum, row) => sum + row.people, 0) : inEnvironment.total;

  const joinedBefore = options.minTenureYears ? tenureCutoff(now, options.minTenureYears) : undefined;
  const shortlistFilter = personFilter(role, { seniority: options.seniority, ...(joinedBefore ? { joinedBefore } : {}) });
  const target =
    options.seniority.length > 0 || joinedBefore ? await client.people.count({ filter: shortlistFilter, ...company }) : inEnvironment;

  const unclassified = Math.max(0, inEnvironment.total - classified);
  const levels = seniorityTotals.filter((row) => row.people > 0).map((row) => `${row.seniority} ${format(row.people)}`);
  if (unclassified > 0) levels.push(`no level listed ${format(unclassified)}`);
  log(`  In the environment: ${format(inEnvironment.total)}${levels.length > 0 ? ` (${levels.join(', ')})` : ''}`);
  if (options.seniority.length > 0) log(`  At ${options.seniority.join(', ')} level: ${format(selected)}`);
  if (joinedBefore) log(`  Joined their company on or before ${joinedBefore}: ${format(target.total)}`);

  const result: TalentMap = {
    generatedAt: now.toISOString(),
    status: 'complete',
    options,
    role,
    environment,
    sizing: {
      withTitle,
      market: market.total,
      inEnvironment: inEnvironment.total,
      bySeniority: seniorityTotals,
      unclassified,
      selected,
      target: target.total,
      targetAccessible: target.count,
      ...(joinedBefore ? { joinedBefore } : {}),
    },
    companies: [],
    shortlist: [],
    credits: { maxCredits: options.maxCredits, estimate: [], spent: 0, entries: ledger.entries, balanceBefore },
    notes: [],
  };
  if (environment.query?.semantic) {
    result.notes.push(
      `A plain-English company description limits people search to the ${format(SEMANTIC_COMPANY_LIMIT)} best-matching companies. The company count is the size of the semantic candidate pool, not a strict match count.`,
    );
  }

  if (target.count === 0) {
    log('  Nobody matches, so the paid steps are skipped. Loosen the seniority, tenure or company filters.');
    result.status = 'no-matches';
  } else {
    const pageSize = shortlistSize(options.people, target.count);
    result.credits.estimate = estimatePaidSteps(pageSize, options.trendTop);
    printEstimate(result.credits.estimate, options.maxCredits, log);
    if (options.dryRun) {
      log('Dry run: no paid calls made.');
      result.status = 'dry-run';
    } else {
      try {
        await runPaidSteps(result, { client, log, now, ledger, shortlistFilter, company, pageSize });
      } catch (error) {
        // Keep what was already paid for: the caller writes it out before reporting the error.
        result.status = 'stopped';
        result.stoppedBecause = error instanceof Error ? error.message : String(error);
        result.credits.spent = ledger.spent;
        result.credits.balanceAfter = await balanceIfAvailable(client);
        throw new RunStoppedError(result, error);
      }
    }
  }

  result.credits.spent = ledger.spent;
  result.credits.balanceAfter = await balanceIfAvailable(client);
  return result;
}

interface PaidContext {
  client: CompanyEnrich;
  log: Log;
  now: Date;
  ledger: CreditLedger;
  shortlistFilter: PersonFilter;
  company: Pick<PersonSearchQuery, 'company'>;
  /** At most the free count and what the cap allows; the search can't return more. */
  pageSize: number;
}

/**
 * Steps 4 and 5: the shortlist (2 credits per person) and team trends (1 credit per company).
 * Results are stored on `result` as soon as they are paid for, so a later failure loses nothing.
 */
async function runPaidSteps(result: TalentMap, { client, log, now, ledger, shortlistFilter, company, pageSize }: PaidContext): Promise<void> {
  const { options } = result;
  ledger.check(result.credits.estimate);

  log(`4. Shortlist (paid, up to ${pageSize} profiles)`);
  const page = await client.people.search({ filter: shortlistFilter, ...company, pageSize });
  const [shortlistLine] = result.credits.estimate as [CostLine];
  ledger.record(shortlistLine, searchCharge(page.items.length, COST.person));
  const { candidates, merged } = mergeDuplicates(page.items.map((person) => toCandidate(person, now)));
  result.shortlist = candidates;
  result.companies = groupByCompany(result.shortlist);
  log(`  ${page.items.length} profiles across ${result.companies.length} companies`);
  if (merged > 0) {
    const note = `Merged ${merged} duplicate profile${merged === 1 ? '' : 's'} (same person id, or same name, company and start date): the shortlist has ${candidates.length} people.`;
    log(`  ${note}`);
    result.notes.push(note);
  }

  // Free: how many matching people each shortlisted company holds, to rank the companies.
  await mapLimit(result.companies, MAX_CONCURRENCY, async (row) => {
    row.pool = (await client.people.count({ filter: { ...shortlistFilter, companyId: row.company.id } })).total;
  });
  result.companies = rankCompanies(result.companies);

  const top = result.companies.slice(0, options.trendTop);
  if (top.length === 0) return;
  log(`5. Team trends (paid, ${top.length} companies)`);
  ledger.check([{ step: 'team trends', detail: `${top.length} companies`, credits: top.length * COST.workforcePage }]);
  const keys = headcountKeys(result.role.departments);
  const failures: unknown[] = [];
  // Every lookup settles before an error is raised, so the ledger never misses a charge that landed.
  await mapLimit(top, MAX_CONCURRENCY, async (row) => {
    const line = { step: 'team trend', detail: row.company.name, credits: COST.workforcePage };
    try {
      const workforce = await retryOnRateLimit(() => client.companies.workforce({ id: row.company.id }, { maxRetries: 0 }));
      row.trend = teamTrend(workforce, keys);
      ledger.record(line, COST.workforcePage);
    } catch (error) {
      if (error instanceof NotFoundError) {
        log(`  No workforce data for ${row.company.name} (not charged)`);
        ledger.record(line, 0);
      } else {
        failures.push(error);
      }
    }
  });
  if (failures.length > 0) throw failures[0];
}
