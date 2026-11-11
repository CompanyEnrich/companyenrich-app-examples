import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CompanyEnrich, PaymentRequiredError } from '@companyenrich/sdk';
import type { MonitorConfig, WatcherConfig } from './config.js';
import { CreditBudget } from './credits.js';
import { isoDate } from './dates.js';
import { type Digest, type WatcherReport, renderMarkdown } from './digest.js';
import { describeError } from './errors.js';
import { plural } from './format.js';
import { buildSlackPayload, postToSlack } from './slack.js';
import { type MonitorState, emptyState, loadState, saveState, watcherState } from './state.js';
import { planAccountChanges } from './watchers/account-changes.js';
import { planNewCompanies } from './watchers/new-companies.js';
import { planNewLeaders } from './watchers/new-leaders.js';
import type { WatcherContext, WatcherPlan, WatcherRun } from './watchers/types.js';

export interface RunOptions {
  client: CompanyEnrich;
  config: MonitorConfig;
  statePath: string;
  outputDir: string;
  maxCredits: number;
  dryRun?: boolean;
  /** Start the selected watchers from empty state. Saved only if the run is not a dry run. */
  resetState?: boolean;
  /** Run only these watcher ids. Defaults to all. */
  watcherIds?: string[];
  slackWebhookUrl?: string;
  /** Used for the Slack post. Defaults to the global fetch. */
  slackFetch?: typeof fetch;
  now?: Date;
  log?: (line: string) => void;
}

export interface RunResult {
  /** Missing for dry runs. */
  digest?: Digest;
  digestPath?: string;
  creditsCharged: number;
  /** True when any watcher or the Slack post failed. */
  failed: boolean;
}

interface PlannedWatcher {
  watcher: WatcherConfig;
  plan?: WatcherPlan;
  granted: number;
  error?: string;
}

export async function runMonitor(options: RunOptions): Promise<RunResult> {
  const now = options.now ?? new Date();
  const log = options.log ?? console.log;
  const watchers = selectWatchers(options.config, options.watcherIds);
  const ctx: WatcherContext = { client: options.client, now };

  // Free: confirms the key works before anything else and shows the balance.
  const account = await options.client.me();
  log(`CompanyEnrich balance: ${Math.floor(account.credits.total - account.credits.used)} credits left.`);

  // Resetting every watcher never reads the old file, so it also recovers from a corrupt one.
  const resetAll = options.resetState && !options.watcherIds?.length;
  const state = resetAll ? emptyState() : loadState(options.statePath);
  if (options.resetState) {
    for (const watcher of watchers) delete state.watchers[watcher.id];
    log(`Starting from empty state for: ${watchers.map((watcher) => watcher.id).join(', ')}.`);
  }

  // Step 1: free calls only. Each watcher works out what it would buy.
  log('Checking watchers with free counts...');
  const planned: PlannedWatcher[] = [];
  for (const watcher of watchers) {
    try {
      planned.push({ watcher, plan: await planWatcher(ctx, watcher, state), granted: 0 });
    } catch (error) {
      planned.push({ watcher, granted: 0, error: describeError(error) });
    }
  }

  // Step 2: split the credit cap between watchers, in config order.
  const budget = new CreditBudget(options.maxCredits);
  for (const entry of planned) {
    if (entry.plan) entry.granted = budget.grant(entry.plan);
  }
  log(renderPlan(planned, budget));

  if (options.dryRun) {
    log('Dry run: only free calls were made. State and output files were not changed.');
    return { creditsCharged: 0, failed: planned.some((entry) => entry.error) };
  }

  // Step 3: paid calls, within the grants.
  const reports: WatcherReport[] = [];
  let outOfCredits = false;
  for (const entry of planned) {
    const report: WatcherReport = {
      id: entry.watcher.id,
      type: entry.watcher.type,
      title: entry.watcher.title ?? entry.watcher.id,
      signals: [],
      notes: [],
      creditsCharged: 0,
    };
    reports.push(report);

    if (!entry.plan) {
      report.error = entry.error;
      continue;
    }
    if (outOfCredits) {
      report.error = 'Skipped: the account ran out of credits earlier in this run.';
      continue;
    }
    if (entry.granted === 0 && entry.plan.units > 0) {
      report.notes.push(
        `Deferred by the credit cap: ${plural(entry.plan.units, ...entry.plan.unit)} wait for the next run.`,
      );
      continue;
    }

    // Saves state and records the spend after every paid call, so a failure part way through
    // keeps what was already bought and the digest shows the credits really spent.
    const checkpoint = (progress: WatcherRun) => {
      report.signals = progress.signals;
      report.notes = progress.notes;
      report.creditsCharged = progress.creditsCharged;
      state.watchers[entry.watcher.id] = progress.nextState;
      saveState(options.statePath, state);
    };
    try {
      checkpoint(await entry.plan.execute(entry.granted, checkpoint));
    } catch (error) {
      report.error = describeError(error);
      if (error instanceof PaymentRequiredError) outOfCredits = true;
    }
  }

  // Step 4: the digest goes to the terminal, a Markdown file and (optionally) Slack.
  const digest: Digest = {
    date: isoDate(now),
    reports,
    creditsCharged: reports.reduce((total, report) => total + report.creditsCharged, 0),
    maxCredits: options.maxCredits,
  };
  const markdown = renderMarkdown(digest);
  log('');
  log(markdown);
  const digestPath = writeDigest(options.outputDir, digest.date, markdown);
  log(`Digest written to ${digestPath}`);

  let failed = reports.some((report) => report.error);
  if (options.slackWebhookUrl) {
    try {
      await postToSlack(options.slackWebhookUrl, buildSlackPayload(digest), options.slackFetch);
      log('Digest posted to Slack.');
    } catch (error) {
      log(`Slack post failed: ${describeError(error)}`);
      failed = true;
    }
  }

  return { digest, digestPath, creditsCharged: digest.creditsCharged, failed };
}

export function selectWatchers(config: MonitorConfig, ids: string[] | undefined): WatcherConfig[] {
  if (!ids || ids.length === 0) return config.watchers;
  const unknown = ids.filter((id) => !config.watchers.some((watcher) => watcher.id === id));
  if (unknown.length > 0) {
    const known = config.watchers.map((watcher) => watcher.id).join(', ');
    throw new Error(`Unknown watcher id: ${unknown.join(', ')}. Configured watchers: ${known}.`);
  }
  return config.watchers.filter((watcher) => ids.includes(watcher.id));
}

function planWatcher(ctx: WatcherContext, watcher: WatcherConfig, state: MonitorState): Promise<WatcherPlan> {
  switch (watcher.type) {
    case 'new-companies':
      return planNewCompanies(ctx, watcher, watcherState(state, watcher.id, 'new-companies'));
    case 'new-leaders':
      return planNewLeaders(ctx, watcher, watcherState(state, watcher.id, 'new-leaders'));
    case 'account-changes':
      return planAccountChanges(ctx, watcher, watcherState(state, watcher.id, 'account-changes'));
  }
}

export function renderPlan(planned: PlannedWatcher[], budget: CreditBudget): string {
  const idWidth = Math.max(...planned.map((entry) => entry.watcher.id.length));
  const lines = [`Credit plan (worst case, cap ${budget.cap}):`];
  for (const { watcher, plan, granted, error } of planned) {
    const label = `  ${watcher.id.padEnd(idWidth)}  `;
    if (!plan) {
      lines.push(`${label}error: ${error}`);
      continue;
    }
    let spend: string;
    if (plan.units === 0) spend = 'nothing to fetch';
    else if (granted === 0) spend = `deferred, cap reached (wanted ${plural(plan.units, ...plan.unit)})`;
    else {
      const capped = granted < plan.units ? ` (capped from ${plan.units})` : '';
      spend = `${plural(granted, ...plan.unit)} x ${plan.unitCost} = ${plural(granted * plan.unitCost, 'credit')}${capped}`;
    }
    lines.push(`${label}${plan.finding} -> ${spend}`);
  }
  lines.push(`  Total: up to ${plural(budget.total, 'credit')}.`);
  return lines.join('\n');
}

/** One file per day. A second run on the same day appends below the first. */
function writeDigest(outputDir: string, date: string, markdown: string): string {
  mkdirSync(outputDir, { recursive: true });
  const path = join(outputDir, `digest-${date}.md`);
  if (existsSync(path)) appendFileSync(path, `\n---\n\n${markdown}`);
  else writeFileSync(path, markdown);
  return path;
}
