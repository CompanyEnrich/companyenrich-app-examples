import { join } from 'node:path';
import { type Company, type CompanyEnrich, NotFoundError, type Person, type PersonSearchQuery } from '@companyenrich/sdk';
import type { BuyerPersona, TrackerConfig } from './config.js';
import { COST, CreditLedger, MAX_CONTACTS, creditBalance, planCheck } from './credits.js';
import { type Alert, detectChange } from './detect.js';
import { renderDigest } from './digest.js';
import { normalizeDomain } from './domains.js';
import { describeError, isFatal, mayHaveBeenCharged } from './errors.js';
import { type IcpScore, scoreCompany } from './icp.js';
import { type OutboxEntry, deliver, newOutboxEntry } from './outbox.js';
import { type Experience, companyLabel, currentExperiences, pickPrimary } from './profile.js';
import { paidGet } from './retry.js';
import { dueChampions } from './schedule.js';
import { shellQuote, stateFlag } from './shell.js';
import { type ChampionRecord, StateError, loadState, saveState } from './state.js';

type PersonFilter = NonNullable<PersonSearchQuery['filter']>;

export interface Contact {
  name: string;
  position: string | null;
  linkedinUrl: string | null;
  /** True when this person is one of your tracked champions too. */
  isChampion: boolean;
}

/** What we learned about the company a champion moved to. */
export interface CompanyResearch {
  company: Company | null;
  icp: IcpScore | null;
  /**
   * Other people there who match the buyer persona: `total` is everyone, `accessible` is how many
   * your plan can fetch. Null when they could not be counted.
   */
  persona: { total: number; accessible: number } | null;
  contacts: Contact[];
  notes: string[];
}

export interface ChampionAlert {
  owner: string;
  dealName: string;
  accountDomain: string;
  name: string;
  linkedinUrl: string | null;
  profileUpdatedAt: string | null;
  change: Alert;
  /** Set for moves only. */
  research: CompanyResearch | null;
}

export interface CheckProblem {
  owner: string;
  dealName: string;
  champion: string;
  reason: string;
}

export interface CheckReport {
  date: string;
  tracked: number;
  due: number;
  checked: number;
  unchanged: number;
  deferred: number;
  alerts: ChampionAlert[];
  problems: CheckProblem[];
  spent: number;
  cap: number;
  breakdown: string;
  /** Set when an error such as an empty balance stopped the run early. */
  stoppedBy?: string;
  /** A command that checks the deferred champions now. Set when any were deferred. */
  resumeCommand?: string;
}

export interface CheckOptions {
  client: CompanyEnrich;
  config: TrackerConfig;
  statePath: string;
  outputDir: string;
  maxCredits: number;
  checkEveryDays: number;
  /** Check only champions left pending by an earlier capped or stopped run, whatever the interval. */
  pendingOnly: boolean;
  withContacts: boolean;
  dryRun: boolean;
  /** The --config path the user passed, repeated in the resume command. */
  configPath?: string | undefined;
  slackWebhookUrl?: string | undefined;
  /** Used for the Slack post; injectable for tests. */
  fetch?: typeof fetch;
  now?: Date;
  log?: (line: string) => void;
}

export interface CheckResult {
  /** This run's report. Null for a dry run or when nobody was due. */
  report: CheckReport | null;
  /** Where this run's digest is (or will be, once delivered) written. */
  digestPath: string | null;
  /** Digests from earlier runs delivered now. */
  redelivered: number;
  /** Failed writes or Slack posts. Those digests stay in the outbox for the next run. */
  deliveryErrors: string[];
}

export async function runCheck(options: CheckOptions): Promise<CheckResult> {
  const { client, dryRun } = options;
  const log = options.log ?? console.log;
  const now = options.now ?? new Date();
  const delivery = { outputDir: options.outputDir, slackWebhookUrl: options.slackWebhookUrl, fetch: options.fetch, log };

  const state = loadState(options.statePath);
  if (!state) {
    throw new StateError(`No state at ${options.statePath}. Run "npm start -- init champions.csv${stateFlag(options.statePath)}" first.`);
  }
  const outbox = (state.outbox ??= []);
  const result: CheckResult = { report: null, digestPath: null, redelivered: 0, deliveryErrors: [] };

  // Digests an earlier run could not write or post go out first.
  if (outbox.length > 0 && dryRun) log(`${outbox.length} earlier digests are waiting to be delivered; the next real run retries them.`);
  if (outbox.length > 0 && !dryRun) {
    log(`Delivering ${outbox.length} digests from earlier runs.`);
    for (const entry of [...outbox]) {
      result.deliveryErrors.push(...(await deliver(entry, delivery)));
      if (entry.undelivered.length === 0) result.redelivered++;
    }
    state.outbox = outbox.filter((entry) => entry.undelivered.length > 0);
    saveState(options.statePath, state);
  }

  const due = options.pendingOnly ? state.champions.filter((champion) => champion.pendingCheck) : dueChampions(state.champions, now, options.checkEveryDays);
  const plan = planCheck(due.length, options.maxCredits, options.withContacts);

  const selection = options.pendingOnly
    ? 'pending from earlier runs (--pending-only)'
    : options.checkEveryDays === 0
      ? 'due (--check-every-days 0 makes everyone due)'
      : `due (checked every ${options.checkEveryDays} days)`;
  log(`Tracking ${state.champions.length} champions; ${due.length} ${selection}.`);
  if (state.champions.length === 0) {
    log('No champions are tracked yet. Add your champions to the CSV and run init again.');
    return result;
  }
  if (due.length === 0) {
    log(options.pendingOnly ? 'Nobody is pending, so nothing was fetched.' : 'Nobody is due, so nothing was fetched. Use --check-every-days 0 to check everyone now.');
    return result;
  }

  // Free, and fails fast with a clear message on a bad key before anything is planned or spent.
  const balance = await creditBalance(client);
  const research = options.withContacts ? `company enrichment plus up to ${MAX_CONTACTS} contacts` : 'company enrichment';
  log(`Plan: check ${plan.toCheck} champions at ${COST.personGet} credits each (${plan.estimate} credits if nobody moved). Each move adds up to ${plan.reservePerMove} for ${research}.`);
  log(`Worst case ${plan.worstCase} credits; cap ${options.maxCredits} (--max-credits); balance ${balance.toLocaleString('en-US')}.`);
  if (plan.deferred > 0) log(`${plan.deferred} champions do not fit under the cap and stay pending for the next run.`);

  if (dryRun) {
    for (const record of due.slice(0, plan.toCheck)) log(`  would check: ${record.dealName || record.accountDomain} (owner ${record.owner}, person ${record.personId})`);
    log('Dry run: no paid calls made and no files written.');
    return result;
  }

  const ledger = new CreditLedger(options.maxCredits);
  const championIds = new Set(state.champions.map((champion) => champion.personId));
  const report: CheckReport = {
    date: now.toISOString().slice(0, 10),
    tracked: state.champions.length,
    due: due.length,
    checked: 0,
    unchanged: 0,
    deferred: 0,
    alerts: [],
    problems: [],
    spent: 0,
    cap: options.maxCredits,
    breakdown: '',
  };
  result.report = report;

  const context: CheckContext = { ...options, log, now, ledger, report, championIds };
  let entry: OutboxEntry;
  try {
    for (const record of due) {
      if (report.stoppedBy || !ledger.canAfford(COST.personGet + plan.reservePerMove)) {
        record.pendingCheck = true;
        report.deferred++;
        continue;
      }
      try {
        await checkChampion(record, context);
      } catch (error) {
        // Out of credits, or something unexpected: stop here, but keep and report what was paid for.
        report.stoppedBy = describeError(error);
        record.pendingCheck = true;
        report.deferred++;
      }
    }
  } finally {
    report.spent = ledger.spent;
    report.breakdown = ledger.breakdown();
    if (report.deferred > 0) report.resumeCommand = resumeCommand(report.deferred, plan.reservePerMove, options);
    // One write saves the new baselines, the pending flags and this report in the outbox, so paid
    // results are never lost and an alert can never be marked as seen without being kept for delivery.
    entry = newOutboxEntry(report, state.outbox, delivery);
    state.outbox.push(entry);
    saveState(options.statePath, state);
  }
  result.digestPath = join(options.outputDir, entry.fileName);

  log(`\n${renderDigest(report)}`);
  result.deliveryErrors.push(...(await deliver(entry, delivery)));
  state.outbox = state.outbox.filter((waiting) => waiting.undelivered.length > 0);
  saveState(options.statePath, state);
  log(`Spent ${report.spent} credits (${report.breakdown}), cap ${report.cap}.`);
  return result;
}

/** Checks only the pending champions, with the same contacts, config and state as this run. */
function resumeCommand(deferred: number, reservePerMove: number, options: CheckOptions): string {
  const flags = ['--pending-only', `--max-credits ${deferred * COST.personGet + reservePerMove}`];
  if (options.withContacts) flags.push('--with-contacts');
  if (options.configPath) flags.push(`--config ${shellQuote(options.configPath)}`);
  return `npm start -- check ${flags.join(' ')}${stateFlag(options.statePath)}`;
}

interface CheckContext extends CheckOptions {
  log: (line: string) => void;
  now: Date;
  ledger: CreditLedger;
  report: CheckReport;
  /** Person ids of every tracked champion, to flag contacts you already know. */
  championIds: Set<string>;
}

async function checkChampion(record: ChampionRecord, context: CheckContext): Promise<void> {
  const { client, ledger, report, log } = context;
  const label = record.dealName || record.accountDomain;

  let person: Person;
  try {
    person = await paidGet((requestOptions) => client.people.get(record.personId, undefined, requestOptions));
  } catch (error) {
    if (isFatal(error)) throw error;
    if (mayHaveBeenCharged(error)) ledger.record('people.get (no response)', COST.personGet);
    // The champion stays pending and the next run tries again.
    const reason = error instanceof NotFoundError ? 'profile not found (0 credits); will retry next run' : `${describeError(error)}; will retry next run`;
    report.problems.push({ owner: record.owner, dealName: record.dealName, champion: `person ${record.personId}`, reason });
    record.pendingCheck = true;
    log(`  ${label}: ${reason}`);
    return;
  }
  ledger.record('people.get', COST.personGet);
  report.checked++;
  const change = detectChange(record.baseline, person, record.lastCheckedAt);
  record.lastCheckedAt = context.now.toISOString();
  delete record.pendingCheck;

  const name = person.name ?? `person ${record.personId}`;
  if (change.kind === 'unknown') {
    report.problems.push({ owner: record.owner, dealName: record.dealName, champion: name, reason: change.reason });
    log(`  ${name} (${label}): ${change.reason}`);
    return;
  }
  record.baseline = change.baseline;
  if (change.kind === 'none') {
    report.unchanged++;
    log(`  ${name} (${label}): no change`);
    return;
  }

  log(`  ${name} (${label}): ${change.kind}${change.kind === 'moved' ? ` to ${companyLabel(change.to)}` : ''}`);
  // Recorded before the research, so the alert survives even if the research fails.
  const alert: ChampionAlert = {
    owner: record.owner,
    dealName: record.dealName,
    accountDomain: record.accountDomain,
    name,
    linkedinUrl: person.socials?.linkedinUrl ?? null,
    profileUpdatedAt: person.updatedAt ?? null,
    change,
    research: null,
  };
  report.alerts.push(alert);
  if (change.kind === 'moved') alert.research = await researchCompany(change.to, person.name ?? null, context);
}

/** Enriches the new company (1 credit), scores it, and counts buyer-persona contacts there (free). */
async function researchCompany(role: Experience, championName: string | null, context: CheckContext): Promise<CompanyResearch> {
  const { client, config, ledger } = context;
  const research: CompanyResearch = { company: null, icp: null, persona: null, contacts: [], notes: [] };
  const domain = normalizeDomain(role.company?.domain);
  const companyId = role.company?.id;
  if (!domain && !companyId) {
    research.notes.push(`"${companyLabel(role)}" has no company record in CompanyEnrich, so it was not enriched.`);
    return research;
  }

  try {
    // The ledger always holds this credit back before a profile fetch (see planCheck).
    research.company = await paidGet((requestOptions) =>
      domain ? client.companies.enrich({ domain }, requestOptions) : client.companies.get(companyId!, undefined, requestOptions),
    );
    ledger.record(domain ? 'companies.enrich' : 'companies.get', COST.companyEnrich);
    research.icp = scoreCompany(research.company, config.icp);
  } catch (error) {
    if (mayHaveBeenCharged(error)) ledger.record('companies.enrich (no response)', COST.companyEnrich);
    research.notes.push(
      error instanceof NotFoundError ? `${domain || companyLabel(role)} was not found in CompanyEnrich (0 credits).` : `Enrichment failed: ${describeError(error)}`,
    );
  }

  const filter = personaFilter(config.buyerPersona, { id: companyId ?? research.company?.id, domain }, championName);
  try {
    const { total, count } = await client.people.count({ filter });
    research.persona = { total, accessible: count };
  } catch (error) {
    research.notes.push(`Could not count buyer-persona contacts: ${describeError(error)}`);
    return research;
  }

  if (context.withContacts && research.persona.accessible > 0) {
    const pageSize = Math.min(MAX_CONTACTS, research.persona.accessible, Math.floor(ledger.remaining / COST.contact));
    if (pageSize === 0) {
      research.notes.push('Contacts skipped: the credit cap was reached.');
      return research;
    }
    try {
      const { items } = await client.people.search({ filter, pageSize });
      // An empty page still bills one result.
      ledger.record('people.search', COST.contact * Math.max(items.length, 1));
      research.contacts = items.map((contact) => ({
        name: contact.name ?? `person ${contact.id}`,
        // The top-level position is often a headline; prefer the title of their role at this company.
        position: roleAt(contact, companyId ?? research.company?.id, domain)?.position ?? contact.position ?? null,
        linkedinUrl: contact.socials?.linkedinUrl ?? null,
        isChampion: context.championIds.has(String(contact.id)),
      }));
    } catch (error) {
      if (mayHaveBeenCharged(error)) ledger.record('people.search (no response)', COST.contact * pageSize);
      research.notes.push(`Could not fetch contacts: ${describeError(error)}`);
    }
  }
  return research;
}

function roleAt(person: Person, companyId: string | undefined, domain: string): Experience | undefined {
  return pickPrimary(
    currentExperiences(person).filter((experience) => (companyId && experience.company?.id === companyId) || (domain && normalizeDomain(experience.company?.domain) === domain)),
  );
}

/**
 * People at the new company who match the buyer persona. The champion is excluded by name: the
 * name filter is a text search, so the quotes make it match the full name only.
 */
export function personaFilter(persona: BuyerPersona, company: { id?: string | undefined; domain: string }, excludeName: string | null): PersonFilter {
  return {
    ...(company.id ? { companyId: company.id } : { domain: company.domain }),
    seniority: persona.seniority,
    ...(persona.department.length > 0 ? { department: persona.department } : {}),
    ...(excludeName ? { query: { notIn: [`"${excludeName.replaceAll('"', '')}"`] } } : {}),
  };
}
