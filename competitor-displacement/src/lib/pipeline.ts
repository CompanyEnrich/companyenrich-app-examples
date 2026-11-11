import { access, constants, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompanyEnrich } from '@companyenrich/sdk';
import { estimateContacts, estimateContactsUpperBound, fetchContacts, personaReach, planContacts, type ContactPlanItem } from './contacts.js';
import { BudgetExceededError, CreditLedger, formatEstimate, type CostLine, type LedgerEntry } from './credits.js';
import { UsageError } from './errors.js';
import { buildTargetFilter, type TargetSpec } from './filters.js';
import { choosePersona, type PersonaChoice, type PersonaName } from './personas.js';
import { accountsCsv, contactsCsv, renderReport } from './report.js';
import { sizeMarket, type MarketSize } from './sizing.js';
import { resolveTechnology } from './technologies.js';
import { estimateAccounts, fillAccounts, sizeTiers, tierFilters, TIERS, type TierSizes } from './tiers.js';
import type { Account, Category, CompanyFilter, Contact, EmployeeRange, Log, Tier } from './types.js';

export interface PipelineOptions {
  competitor: string;
  mine?: string | undefined;
  countries: string[];
  employees: EmployeeRange[];
  categories: Category[];
  accounts: number;
  contacts: number;
  persona?: PersonaName | undefined;
  withFunding: boolean;
  maxCredits: number;
  /** Domains to leave out of every count and search, e.g. accounts bought in a previous run. */
  exclude: string[];
  dryRun: boolean;
  outDir: string;
}

export interface PipelineContext {
  client: CompanyEnrich;
  log: Log;
  now?: () => Date;
}

export type RunStatus = 'complete' | 'dry-run' | 'no-targets' | 'stopped-by-budget' | 'failed';

export interface RunRecord {
  runId: string;
  startedAt: string;
  status: RunStatus;
  /** Why the run stopped early, for `stopped-by-budget` and `failed`. */
  note?: string | undefined;
  options: PipelineOptions;
  spec: TargetSpec;
  filters: { target: CompanyFilter; tiers: Record<Tier, CompanyFilter> };
  market: MarketSize;
  tiers: TierSizes;
  persona: PersonaChoice & { reach: number };
  /** The cost of the paid steps as estimated before any spending (also filled in for dry runs). */
  estimate: CostLine[];
  accounts: Account[];
  contactPlan: ContactPlanItem[];
  contacts: Contact[];
  credits: { maxCredits: number; spent: number; entries: LedgerEntry[]; balanceBefore?: number | undefined; balanceAfter?: number | undefined };
  outputDir: string;
  files: string[];
}

/** Runs the whole play: validate, size, tier, fetch accounts, find buyers, write the report. */
export async function runPipeline(options: PipelineOptions, { client, log, now = () => new Date() }: PipelineContext): Promise<RunRecord> {
  const started = now();
  const me = await client.me(); // also fails fast on a bad key, before any other call
  const balanceBefore = me.credits.total - me.credits.used;

  // Every exclusion and every fetched domain shares one `domain.notIn` rule, which the plan caps.
  const termLimit = me.capabilities.searchTermLimit;
  if (options.exclude.length + options.accounts > termLimit) {
    throw new UsageError(
      `--exclude has ${options.exclude.length} domains; with --accounts ${options.accounts} that passes your plan's limit of ${termLimit} terms in one filter. Use a shorter list or fewer accounts.`,
    );
  }

  log('1. Validating technologies (free autocomplete)');
  const competitor = await resolveTechnology(client, options.competitor, '--competitor');
  const mine = options.mine ? await resolveTechnology(client, options.mine, '--mine') : undefined;
  if (mine === competitor) throw new UsageError('--competitor and --mine must be different technologies.');
  log(`   competitor: ${competitor}${mine ? `, yours: ${mine}` : ''}${options.exclude.length > 0 ? `, excluding ${options.exclude.length} domains` : ''}`);

  // Fail on an unusable --out now, not after paying for accounts.
  const runId = makeRunId(started, competitor, mine);
  const outputDir = await prepareOutputDir(options.outDir, runId);

  const spec: TargetSpec = {
    competitor,
    mine,
    countries: options.countries,
    employees: options.employees,
    categories: options.categories,
    exclude: options.exclude,
  };
  const target = buildTargetFilter(spec);
  const filters = { target, tiers: tierFilters(target, started) };

  log('2. Sizing the market (free counts)');
  const market = await sizeMarket(client, spec);
  log(`   ${market.targets.toLocaleString('en-US')} companies run ${competitor}${mine ? ` and not ${mine}` : ''}`);

  log('3. Ranking by why-now signals (free counts)');
  const tiers = await sizeTiers(client, target, market.targets, started);
  log(`   ${TIERS.map((tier) => `tier ${tier}: ${tiers[tier].toLocaleString('en-US')}`).join(', ')}`);

  const choice = choosePersona(competitor, options.persona);
  const reach = market.targets > 0 ? await personaReach(client, choice.persona, target) : 0;
  log(`Buyer persona: ${choice.name} (${choice.reason})`);

  const planned = Math.min(options.accounts, tiers[1] + tiers[2] + tiers[3]);
  const estimate = [
    estimateAccounts({ accounts: options.accounts, sizes: tiers, withFunding: options.withFunding }),
    estimateContactsUpperBound(planned, options.contacts),
  ];

  const ledger = new CreditLedger(options.maxCredits);
  const run: RunRecord = {
    runId,
    startedAt: started.toISOString(),
    status: 'complete',
    options,
    spec,
    filters,
    market,
    tiers,
    persona: { ...choice, reach },
    estimate,
    accounts: [],
    contactPlan: [],
    contacts: [],
    credits: { maxCredits: options.maxCredits, spent: 0, entries: ledger.entries, balanceBefore },
    outputDir,
    files: [],
  };

  if (market.targets === 0) {
    run.status = 'no-targets';
    log('   No companies match, so there is nothing to fetch. No credits spent.');
  } else if (options.dryRun) {
    run.status = 'dry-run';
    log(`Dry run: stopping before paid steps.\n${formatEstimate(estimate, 0, options.maxCredits)}`);
  } else {
    await runPaidSteps(run, { client, log, ledger });
  }

  // Save what was bought first; the closing balance is a nice-to-have.
  await writeOutputs(run, ledger);
  try {
    const after = await client.me();
    run.credits.balanceAfter = after.credits.total - after.credits.used;
    await writeOutputs(run, ledger);
  } catch {
    log('Could not read the closing balance; the ledger in run.json is this run\'s spend.');
  }
  return run;
}

/**
 * Steps 4 and 5. Accounts and contacts land in `run` as each page arrives, so a budget stop or an
 * API failure part way still leaves a report and a ledger of everything that was paid for.
 */
async function runPaidSteps(run: RunRecord, { client, log, ledger }: { client: CompanyEnrich; log: Log; ledger: CreditLedger }): Promise<void> {
  const { options } = run;
  try {
    ledger.check(run.estimate, log);

    log('4. Fetching accounts, tier 1 first (paid)');
    const plan = { filters: run.filters.tiers, sizes: run.tiers, accounts: options.accounts, withFunding: options.withFunding, now: new Date(run.startedAt) };
    await fillAccounts(client, plan, ledger, log, run.accounts);

    if (options.contacts > 0 && run.accounts.length > 0) {
      log(`5. Finding the buyer: ${run.persona.persona.buyer} (free counts, then paid search)`);
      run.contactPlan = await planContacts(client, run.accounts, run.persona.persona, options.contacts);
      ledger.check([estimateContacts(run.contactPlan)], log);
      await fetchContacts(client, run.contactPlan, ledger, log, run.contacts);
    }
  } catch (error) {
    run.note = error instanceof Error ? error.message : String(error);
    if (error instanceof BudgetExceededError) {
      run.status = 'stopped-by-budget';
      return;
    }
    run.status = 'failed';
    await writeOutputs(run, ledger).then(
      () => log(`Saved ${run.accounts.length} accounts, ${run.contacts.length} contacts and the ledger (${ledger.spent} credits spent) to ${run.outputDir}`),
      (writeError: Error) => log(`Could not save the partial run: ${writeError.message}`),
    );
    throw error;
  }
}

function makeRunId(date: Date, competitor: string, mine?: string): string {
  const stamp = date.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [stamp, slug(competitor), ...(mine ? ['not', slug(mine)] : [])].join('-');
}

/** Creates the run folder and checks it is writable, turning file system errors into one clear line. */
async function prepareOutputDir(outDir: string, runId: string): Promise<string> {
  const dir = join(outDir, runId);
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
  } catch (error) {
    throw new UsageError(`Cannot write to --out "${outDir}": ${(error as Error).message}`);
  }
  return dir;
}

async function writeOutputs(run: RunRecord, ledger: CreditLedger): Promise<void> {
  run.credits.spent = ledger.spent;
  run.contacts.sort((a, b) => a.account.rank - b.account.rank); // searches finish in any order
  const files: [string, string][] = [['report.md', renderReport(run)]];
  if (run.accounts.length > 0) {
    files.push(['accounts.csv', accountsCsv(run.accounts)], ['contacts.csv', contactsCsv(run.contacts)]);
  }
  files.push(['run.json', `${JSON.stringify(runJson(run), null, 2)}\n`]);
  for (const [name, content] of files) await writeFile(join(run.outputDir, name), content);
  run.files = files.map(([name]) => name);
}

/** The machine-readable record: inputs, filters, counts and the credits ledger. Full profiles live in the CSVs. */
function runJson(run: RunRecord) {
  return {
    runId: run.runId,
    startedAt: run.startedAt,
    status: run.status,
    note: run.note,
    options: { ...run.options, exclude: run.options.exclude.length },
    filters: run.filters,
    market: run.market,
    tiers: run.tiers,
    persona: { name: run.persona.name, reason: run.persona.reason, reach: run.persona.reach, ...run.persona.persona },
    accounts: run.accounts.map(({ rank, tier, signals, company }) => ({ rank, tier, signals, domain: company.domain })),
    contacts: run.contacts.length,
    credits: { estimate: run.estimate, ...run.credits },
  };
}
