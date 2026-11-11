import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BadRequestError, ValidationError, type CompanyExpansion, type CurrentUser } from '@companyenrich/sdk';
import { BudgetExceededError, COST, CreditLedger, formatEstimate, searchCharge, type CostLine, type LedgerEntry } from './credits.js';
import { readCustomerDomains, type InvalidRow } from './domains.js';
import { CompanyCache, enrichMissing, loadCached } from './enrich.js';
import { UsageError } from './errors.js';
import { deriveIcp, parseIcpFile, type DerivedIcp } from './icp.js';
import { buildLookalikeQuery, customerDomains, selectSeeds, toAccounts, type Account, type Customer } from './lookalikes.js';
import { sizeMarket, type Relaxation } from './market.js';
import { allocateContacts, countPeople, findPeople, type PersonaName } from './people.js';
import { buildProfile } from './profile.js';
import { accountsCsv, contactsCsv, renderIcpFile, renderProfile, type Contact } from './report.js';
import type { Company, CompanyEnrich, CompanySearchFilter, Log } from './types.js';

export interface PipelineOptions {
  csvPath: string;
  /** Lookalike accounts to fetch (5 credits each). */
  accounts: number;
  /** People to fetch across the accounts (2 credits each). */
  contacts: number;
  persona: PersonaName;
  /** Adds the technologies expansion to enrichment (+1 credit per customer). */
  withTech: boolean;
  /** Reuse this icp.json instead of profiling the customers. */
  icpPath?: string | undefined;
  minShare: number;
  maxCredits: number;
  dryRun: boolean;
  outDir: string;
}

export interface PipelineDeps {
  client: CompanyEnrich;
  log: Log;
  now?: () => Date;
}

export interface RunRecord {
  runId: string;
  status: 'running' | 'completed' | 'dry-run' | 'stopped' | 'failed';
  error?: string;
  startedAt: string;
  finishedAt?: string;
  outputDir: string;
  files: string[];
  inputs: PipelineOptions;
  customers: {
    domains: number;
    invalidRows: InvalidRow[];
    duplicates: number;
    fromCache: number;
    enriched: number;
    notFound: string[];
    pending: string[];
  };
  icp?: {
    source: 'derived' | 'file';
    filter: CompanySearchFilter;
    /** The ICP after relaxation: what the market count and lookalike search used. */
    searchedWith: CompanySearchFilter;
    relaxed: Relaxation[];
  };
  counts: {
    market?: { count: number; total: number };
    lookalikePool?: { count: number; total: number };
    people?: { account: string; available: number; requested: number; fetched: number }[];
  };
  seeds?: string[];
  credits: {
    maxCredits: number;
    spent: number;
    ledger: LedgerEntry[];
    balanceBefore?: number;
    balanceAfter?: number;
  };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const balanceOf = (user: CurrentUser) => Math.round((user.credits.total - user.credits.used) * 100) / 100;

export async function runPipeline(options: PipelineOptions, { client, log, now = () => new Date() }: PipelineDeps): Promise<RunRecord> {
  const startedAt = now();
  const runId = startedAt.toISOString().slice(0, 19).replaceAll(':', '-');
  const runDir = path.join(options.outDir, runId);
  const ledger = new CreditLedger(options.maxCredits);
  const run: RunRecord = {
    runId,
    status: 'running',
    startedAt: startedAt.toISOString(),
    outputDir: runDir,
    files: [],
    inputs: options,
    customers: { domains: 0, invalidRows: [], duplicates: 0, fromCache: 0, enriched: 0, notFound: [], pending: [] },
    counts: {},
    credits: { maxCredits: options.maxCredits, spent: 0, ledger: ledger.entries },
  };

  const write = async (name: string, content: string) => {
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, name), content);
    if (!run.files.includes(name)) run.files.push(name);
  };

  try {
    run.status = await execute();
  } catch (error) {
    run.status = error instanceof BudgetExceededError ? 'stopped' : 'failed';
    run.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    run.finishedAt = now().toISOString();
    run.credits.spent = ledger.spent;
    if (run.credits.balanceBefore !== undefined) {
      // After a failure the balance is still worth recording, but its lookup must not hide the error.
      run.credits.balanceAfter = await client.me().then(balanceOf, () => undefined);
    }
    // A run that wrote results, spent credits or stopped at the budget guard gets a run.json to audit later.
    if (run.files.length > 0 || ledger.spent > 0 || run.status === 'stopped') {
      await write('run.json', JSON.stringify(run, null, 2) + '\n');
    }
  }
  return run;

  async function execute(): Promise<RunRecord['status']> {
    // 1. Read and normalize the customer list.
    let csvText: string;
    try {
      csvText = await readFile(options.csvPath, 'utf8');
    } catch {
      throw new UsageError(`Cannot read ${options.csvPath}. Pass a CSV with a "domain" column (or domains in the first column).`);
    }
    const list = readCustomerDomains(csvText);
    Object.assign(run.customers, { domains: list.domains.length, invalidRows: list.invalid, duplicates: list.duplicates });
    const removed = list.duplicates ? ` (${plural(list.duplicates, 'duplicate')} removed)` : '';
    log(`1. Customers: ${plural(list.domains.length, 'unique domain')} in ${options.csvPath}${removed}`);
    for (const row of list.invalid) log(`   Skipped row ${row.row}: "${row.value}" is not a domain`);
    if (list.domains.length === 0) throw new UsageError(`No valid domains found in ${options.csvPath}.`);

    // Every input is checked before the first paid call, including an edited ICP file.
    const icpFromFile = options.icpPath ? await readIcpFile(options.icpPath) : undefined;
    run.credits.balanceBefore = balanceOf(await client.me());
    if (icpFromFile && options.icpPath) await checkIcpWithApi(client, icpFromFile, options.icpPath);
    const { items: industries } = await client.industries.list(); // free: industry name -> NAICS prefixes
    const industryCodes = new Map(industries.map((industry) => [industry.name, industry.naicsCodes]));

    // 2. Enrich, reading the local cache first so a re-run is not billed again.
    const expand: CompanyExpansion[] = options.withTech ? ['technologies'] : [];
    const cache = new CompanyCache(path.join(options.outDir, '.cache'));
    const cached = await loadCached(list.domains, expand, cache);
    const missing = list.domains.filter((domain) => !cached.has(domain));
    run.customers.fromCache = cached.size;
    log(`2. Enrichment: ${cached.size} cached, ${missing.length} to enrich`);

    const pricePerCompany = COST.enrich + expand.length * COST.expansion;
    const enrichLine: CostLine = {
      step: 'enrich',
      detail: `${plural(missing.length, 'customer')} x ${pricePerCompany}`,
      credits: missing.length * pricePerCompany,
    };
    const lookalikeLine = (accounts: number): CostLine => ({
      step: 'lookalikes',
      detail: `${plural(accounts, 'account')} x ${COST.lookalike}`,
      credits: accounts * COST.lookalike,
    });
    const peopleLine = (people: number): CostLine => ({
      step: 'contacts',
      detail: `${plural(people, 'person', 'people')} x ${COST.person}`,
      credits: people * COST.person,
    });

    const companies = new Map<string, Company>(cached);
    if (options.dryRun) {
      const lines = [enrichLine, lookalikeLine(options.accounts), peopleLine(options.contacts)];
      const total = lines.reduce((sum, line) => sum + line.credits, 0);
      log(formatEstimate(lines, 0, total, options.maxCredits));
      if (cached.size === 0 && !options.icpPath) {
        log('Dry run: no cached enrichment and no --icp file, so there is nothing to count for free yet.');
        log(`A full run with these flags costs up to ${total} credits.`);
        return 'dry-run';
      }
      if (missing.length > 0) log(`   Dry run: working with the ${cached.size} cached customers only`);
    } else if (missing.length > 0) {
      ledger.check([enrichLine, lookalikeLine(options.accounts), peopleLine(options.contacts)], log);
      const enrichment = await enrichMissing(client, missing, expand, cache, (domains, credits) =>
        ledger.record('enrich', `${plural(domains, 'domain')} x ${pricePerCompany}`, domains * pricePerCompany, credits),
      );
      for (const [domain, company] of enrichment.companies) companies.set(domain, company);
      Object.assign(run.customers, { notFound: [...enrichment.notFound, ...enrichment.invalid], pending: enrichment.pending });
      if (enrichment.notFound.length + enrichment.invalid.length > 0) {
        log(`   Not found: ${[...enrichment.notFound, ...enrichment.invalid].join(', ')}`);
      }
      if (enrichment.pending.length > 0) log(`   Still enriching (re-run later): ${enrichment.pending.join(', ')}`);
      log(`   Enriched ${enrichment.companies.size} (${enrichment.credits} credits)`);
    }
    const customers: Customer[] = list.domains.map((domain) => ({ domain, company: companies.get(domain) }));
    const found = customers.flatMap((customer) => (customer.company ? [customer.company] : []));
    run.customers.enriched = found.length;

    // 3-4. Profile the customers and turn the common values into an ICP filter, or load an edited one.
    let icp: CompanySearchFilter;
    let derived: DerivedIcp | undefined;
    let profile: ReturnType<typeof buildProfile> | undefined;
    if (icpFromFile) {
      icp = icpFromFile;
      log(`3-4. ICP: loaded from ${options.icpPath} (profiling skipped)`);
    } else {
      if (found.length === 0) throw new UsageError('None of the customer domains were found, so there is nothing to profile.');
      profile = buildProfile(found);
      derived = deriveIcp(profile, options.minShare, industryCodes);
      icp = derived.filter;
      log(`3. Profile: ${found.length} customers`);
      log(`4. ICP (values shared by at least ${Math.round(options.minShare * 100)}% of customers):`);
      for (const [dimension, values] of Object.entries(derived.selected)) log(`   ${dimension}: ${values.join(', ')}`);
      if (Object.keys(icp).length === 0) log('   Nothing reached --min-share, so the ICP is empty. Try a lower --min-share.');
    }

    // 5. Size the market for free, relaxing the ICP if nothing matches.
    const market = await sizeMarket(client, icp);
    run.icp = { source: options.icpPath ? 'file' : 'derived', filter: icp, searchedWith: market.filter, relaxed: market.relaxed };
    run.counts.market = { count: market.count, total: market.total };
    log(`5. Market: ${market.count.toLocaleString('en-US')} companies match the ICP (free count)`);
    for (const step of market.relaxed) {
      log(`   Relaxed ${step.dimension} (${step.soloTotal.toLocaleString('en-US')} on its own) -> ${step.countAfter.toLocaleString('en-US')} matches`);
    }
    if (profile && derived) {
      const date = startedAt.toISOString().slice(0, 10);
      await write('profile.md', renderProfile({ csvPath: options.csvPath, date, minShare: options.minShare, profile, icp: derived, market }));
    }
    const industryNames = derived?.selected.industry;
    await write(
      'icp.json',
      renderIcpFile({
        filter: icp,
        about: derived
          ? `Derived from ${found.length} customers: a value is included when at least ${Math.round(options.minShare * 100)}% of them share it. Edit "filter" and re-run with --icp. Filter reference: https://docs.companyenrich.com`
          : `Loaded from ${options.icpPath}.`,
        ...(industryNames ? { industries: Object.fromEntries(industryNames.map((name) => [name, industryCodes.get(name) ?? []])) } : {}),
      }),
    );

    // 6. Lookalikes: similar to the best-fitting customers, inside the ICP, excluding customers.
    const seeds = selectSeeds(customers, icp, industryCodes);
    run.seeds = seeds;
    const query = buildLookalikeQuery(seeds, market.filter, customerDomains(customers));
    const pool = await client.companies.count(query);
    run.counts.lookalikePool = { count: pool.count, total: pool.total };
    log(`6. Lookalikes: ${pool.count.toLocaleString('en-US')} candidates similar to ${seeds.length} seed customers (free count)`);
    if (pool.count === 0) {
      log('   No lookalikes match. Loosen icp.json (widen or remove a dimension) and re-run with --icp.');
      return options.dryRun ? 'dry-run' : 'completed';
    }
    const accountsToFetch = Math.min(options.accounts, pool.count);
    if (options.dryRun) {
      const lines = [lookalikeLine(accountsToFetch), peopleLine(options.contacts)];
      log(formatEstimate(lines, 0, lines.reduce((sum, line) => sum + line.credits, 0), options.maxCredits));
      log('Dry run: stopping before the paid lookalike search.');
      return 'dry-run';
    }
    ledger.check([lookalikeLine(accountsToFetch), peopleLine(options.contacts)], log);
    const response = await client.companies.search({ ...query, pageSize: accountsToFetch });
    const lookalikeEstimate = lookalikeLine(accountsToFetch);
    ledger.record('lookalikes', lookalikeEstimate.detail, lookalikeEstimate.credits, searchCharge(response.items.length, COST.lookalike));
    const accounts = toAccounts(response, icp, industryCodes);
    await write('accounts.csv', accountsCsv(accounts));
    for (const account of accounts) log(`   ${formatAccount(account)}`);

    // 7. People: the persona at each account, best accounts first.
    await findContacts(accounts);
    return 'completed';

    /** Writes contacts.csv even if a later search fails, so people already paid for are kept. */
    async function findContacts(accounts: Account[]): Promise<void> {
      const contacts: Contact[] = [];
      try {
        await collectContacts(accounts, contacts);
      } finally {
        await write('contacts.csv', contactsCsv(contacts));
      }
    }

    async function collectContacts(accounts: Account[], contacts: Contact[]): Promise<void> {
      if (options.contacts === 0 || accounts.length === 0) return;
      const domains = accounts.map((account) => account.company.domain);
      const available = await countPeople(client, domains, options.persona);
      const allocation = allocateContacts(available, options.contacts);
      const requested = allocation.reduce((sum, count) => sum + count, 0);
      const matches = plural(available.reduce((sum, count) => sum + count, 0), `${options.persona} match`, `${options.persona} matches`);
      log(`7. Contacts: ${matches} across ${plural(domains.length, 'account')} (free count)`);
      run.counts.people = domains.map((account, index) => ({ account, available: available[index] ?? 0, requested: allocation[index] ?? 0, fetched: 0 }));
      if (requested === 0) {
        log(`   Nobody matches the ${options.persona} persona at these accounts; no credits spent.`);
        return;
      }
      const estimate = peopleLine(requested);
      ledger.check([estimate], log);
      for (const [index, domain] of domains.entries()) {
        const pageSize = allocation[index] ?? 0;
        if (pageSize === 0) continue;
        const people = await findPeople(client, domain, options.persona, pageSize);
        ledger.record('contacts', `${domain}: ${pageSize} x ${COST.person}`, pageSize * COST.person, searchCharge(people.length, COST.person));
        const counts = run.counts.people?.[index];
        if (counts) counts.fetched = people.length;
        contacts.push(...people.map((person) => ({ account: domain, person })));
      }
      log(`   Found ${plural(contacts.length, 'contact')}`);
    }
  }
}

/** Sends an edited ICP to the free count endpoint, so a bad field or value fails before any spend. */
async function checkIcpWithApi(client: CompanyEnrich, filter: CompanySearchFilter, icpPath: string): Promise<void> {
  try {
    await client.companies.count({ filter });
  } catch (error) {
    if (!(error instanceof BadRequestError || error instanceof ValidationError)) throw error;
    const fields = Object.entries(error.errors ?? {}).map(([field, messages]) => `${field}: ${messages.join(' ')}`);
    const detail = [error.detail, ...fields].filter(Boolean).join('; ');
    throw new UsageError(
      `The API rejected the filter in ${icpPath} (${error.status})${detail ? `: ${detail}` : ''}. ` +
        'Check its field names and values against https://docs.companyenrich.com.',
    );
  }
}

async function readIcpFile(icpPath: string): Promise<CompanySearchFilter> {
  let text: string;
  try {
    text = await readFile(icpPath, 'utf8');
  } catch {
    throw new UsageError(`Cannot read the ICP file ${icpPath}.`);
  }
  return parseIcpFile(text, icpPath);
}

function formatAccount({ rank, company, score, matched }: Account): string {
  const scoreText = score === undefined ? '' : ` score ${score.toFixed(3)}`;
  return `${rank}. ${company.domain} (${company.name ?? 'unnamed'})${scoreText}, matches: ${matched.join(', ') || 'none'}`;
}
