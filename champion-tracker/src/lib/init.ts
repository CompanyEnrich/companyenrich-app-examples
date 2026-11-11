import { type CompanyEnrich, NotFoundError, type Person } from '@companyenrich/sdk';
import { type ChampionRow, championKey } from './csv.js';
import { COST, CreditLedger, creditBalance } from './credits.js';
import { normalizeDomain } from './domains.js';
import { describeError, isFatal, mayHaveBeenCharged } from './errors.js';
import { type Baseline, baselineAt, companyLabel, currentExperiences, pickPrimary } from './profile.js';
import { paidGet } from './retry.js';
import { shellQuote, stateFlag } from './shell.js';
import { type ChampionRecord, loadState, saveState } from './state.js';

export interface InitOptions {
  client: CompanyEnrich;
  rows: ChampionRow[];
  /** Where the rows came from, for the command that resumes a capped run. */
  csvPath: string;
  statePath: string;
  maxCredits: number;
  dryRun: boolean;
  now?: Date;
  log?: (line: string) => void;
}

export interface InitSummary {
  tracked: number;
  added: number;
  kept: number;
  removed: number;
  notFound: number;
  failed: number;
  deferred: number;
  spent: number;
  /** Set when an error such as an invalid key or an empty balance stopped the run early. */
  stoppedBy?: string;
}

/**
 * Resolves each CSV row to a CompanyEnrich person and stores a baseline for it. Safe to re-run:
 * rows already tracked cost nothing, and champions no longer in the CSV are removed from state.
 */
export async function runInit(options: InitOptions): Promise<InitSummary> {
  const { client, statePath, dryRun } = options;
  const log = options.log ?? console.log;
  const now = (options.now ?? new Date()).toISOString();

  const previous = new Map((loadState(statePath)?.champions ?? []).map((record) => [record.key, record]));
  const rows = withoutDuplicates(options.rows, log);
  const records = new Map<string, ChampionRecord>();
  const toResolve: { row: ChampionRow; key: string }[] = [];
  for (const { row, key } of rows) {
    const known = previous.get(key);
    if (known && known.accountDomain === row.accountDomain) records.set(key, { ...known, dealName: row.dealName, owner: row.owner });
    else toResolve.push({ row, key });
  }
  const keys = new Set(rows.map(({ key }) => key));
  const removed = [...previous.keys()].filter((key) => !keys.has(key)).length;

  // Free, and fails fast with a clear message on a bad key before anything is planned or spent.
  const balance = await creditBalance(client);
  const emailRows = toResolve.filter(({ row }) => !row.personId).length;
  const idRows = toResolve.length - emailRows;
  log(`Champions in the CSV: ${rows.length}`);
  log(`  already tracked:   ${records.size} (0 credits)`);
  log(`  email lookups:     ${emailRows} (${COST.emailLookup} credits each when found, 0 when not found)`);
  log(`  person ids:        ${idRows} (${COST.personGet} credits each)`);
  if (removed > 0) log(`  no longer in the CSV, removed from state: ${removed}`);
  log(`Up to ${emailRows * COST.emailLookup + idRows * COST.personGet} credits; cap ${options.maxCredits} (--max-credits); balance ${balance.toLocaleString('en-US')}.`);

  const summary: InitSummary = { tracked: 0, added: 0, kept: records.size, removed, notFound: 0, failed: 0, deferred: 0, spent: 0 };
  if (dryRun) {
    log('Dry run: nothing was resolved or saved.');
    return summary;
  }

  const ledger = new CreditLedger(options.maxCredits);
  const personIds = new Set([...records.values()].map((record) => record.personId));
  let deferredCost = 0;
  const costOf = (row: ChampionRow) => (row.personId ? COST.personGet : COST.emailLookup);
  // A row that is not resolved keeps its earlier baseline (if it had one) rather than dropping the champion.
  const keepPrevious = (key: string) => {
    const known = previous.get(key);
    if (known) records.set(key, known);
  };

  const resolve = async ({ row, key }: { row: ChampionRow; key: string }) => {
    let person: Person;
    try {
      person = row.personId
        ? await paidGet((requestOptions) => client.people.get(row.personId!, undefined, requestOptions))
        : await client.people.enrich({ email: row.email! });
    } catch (error) {
      if (isFatal(error)) throw error;
      if (mayHaveBeenCharged(error)) ledger.record(`${row.personId ? 'people.get' : 'people.enrich'} (no response)`, costOf(row));
      if (error instanceof NotFoundError) {
        summary.notFound++;
        log(`line ${row.line}: no person found for ${row.personId ? `person_id ${row.personId}` : row.email} (0 credits)`);
      } else {
        summary.failed++;
        log(`line ${row.line}: ${describeError(error)}`);
      }
      keepPrevious(key);
      return;
    }
    ledger.record(row.personId ? 'people.get' : 'people.enrich', costOf(row));

    const personId = String(person.id);
    const name = person.name ?? `person ${personId}`;
    if (personIds.has(personId)) {
      log(`line ${row.line}: ${name} is already tracked from another row, skipped (one deal per champion).`);
      return;
    }
    personIds.add(personId);

    const { baseline, atAccount } = initialBaseline(person, row.accountDomain);
    records.set(key, { key, personId, accountDomain: row.accountDomain, dealName: row.dealName, owner: row.owner, baseline, lastCheckedAt: now });
    summary.added++;
    if (atAccount) {
      log(`line ${row.line}: ${name}, ${baseline.position ?? 'unknown position'} at ${baseline.companyName} (${costOf(row)} credits)`);
    } else {
      const roles = currentExperiences(person).map((role) => `${role.position ?? 'unknown position'} at ${companyLabel(role)}`);
      log(
        `line ${row.line}: ${name} is not listed at ${row.accountDomain} right now (current: ${roles.join('; ') || 'none'}). ` +
          `The first check will report this as a move. If ${row.accountDomain} is the wrong domain, fix the CSV and run init again. (${costOf(row)} credits)`,
      );
    }
  };

  for (const item of toResolve) {
    if (!summary.stoppedBy && ledger.canAfford(costOf(item.row))) {
      try {
        await resolve(item);
        continue;
      } catch (error) {
        // Out of credits, or something unexpected: stop here, but keep and report what was paid for.
        summary.stoppedBy = describeError(error);
      }
    }
    summary.deferred++;
    deferredCost += costOf(item.row);
    keepPrevious(item.key);
  }

  const champions = rows.flatMap(({ key }) => records.get(key) ?? []);
  saveState(statePath, { version: 1, champions });
  summary.tracked = champions.length;
  summary.spent = ledger.spent;
  log(
    `Tracking ${summary.tracked} champions: ${summary.added} added, ${summary.kept} already tracked, ${summary.removed} removed, ` +
      `${summary.notFound} not found, ${summary.failed} failed, ${summary.deferred} deferred. Spent ${ledger.spent} credits (${ledger.breakdown()}).`,
  );
  if (summary.stoppedBy) log(`Stopped early: ${summary.stoppedBy}`);
  if (summary.deferred > 0) {
    // Rows already tracked are reused for free, so this only pays for the deferred ones.
    const command = `npm start -- init ${shellQuote(options.csvPath)} --max-credits ${deferredCost}${stateFlag(statePath)}`;
    log(`${summary.deferred} rows were not resolved. ${summary.stoppedBy ? 'Once that is fixed, run' : 'To resolve them, run'} "${command}".`);
  }
  return summary;
}

/**
 * The baseline is the person's role at the account you sold to. If they are no longer listed
 * there, the baseline points at the account with no role and no known other employers, so the
 * first check reports their current employer as a move.
 */
export function initialBaseline(person: Person, accountDomain: string): { baseline: Baseline; atAccount: boolean } {
  const current = currentExperiences(person);
  const role = pickPrimary(current.filter((experience) => normalizeDomain(experience.company?.domain) === accountDomain));
  if (role) return { baseline: baselineAt(role, current), atAccount: true };
  return {
    atAccount: false,
    baseline: {
      status: 'active',
      companyId: null,
      companyDomain: accountDomain,
      companyName: accountDomain,
      position: null,
      seniority: null,
      positionStartDate: null,
      otherCurrentCompanies: [],
    },
  };
}

function withoutDuplicates(rows: ChampionRow[], log: (line: string) => void): { row: ChampionRow; key: string }[] {
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const key = championKey(row);
    if (seen.has(key)) {
      log(`line ${row.line}: duplicate of an earlier row, skipped.`);
      return [];
    }
    seen.add(key);
    return [{ row, key }];
  });
}
