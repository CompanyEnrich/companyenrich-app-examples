import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient, type EnrichClient } from '../lib/client';
import { buildCoverage } from '../lib/coverage';
import { CreditBudget, estimateCredits, PRICES } from '../lib/credits';
import { chooseBlueprint } from '../lib/describe';
import { revealEmail } from '../lib/email';
import { describeError } from '../lib/errors';
import { committeeCsv, coverageCsv, reportMarkdown } from '../lib/export';
import { createClaudeDrafter } from '../lib/llm';
import { mapCommittee } from '../lib/mapping';
import { parseCliArgs, USAGE, type CliOptions } from './args';
import { formatCommittee, formatCoverage, formatEstimate } from './print';

/** Same convention as Next.js: read .env.local if present; variables set in the shell win. */
function loadLocalEnv(): void {
  try {
    process.loadEnvFile('.env.local');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function main(): Promise<void> {
  loadLocalEnv();
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const client = createClient();
  // `me()` is free; reading the balance before and after shows exactly what the run cost.
  const before = (await client.me()).credits.used;

  if (options.revealEmail) await runReveal(client, options);
  else await runCommittee(client, options);

  const { credits } = await client.me();
  console.log(`\nCredits used by this run (from /v2/me): ${round(credits.used - before)}. Account total: ${round(credits.used)} of ${credits.total} used.`);
}

async function runCommittee(client: EnrichClient, options: CliOptions): Promise<void> {
  const drafter = createClaudeDrafter();
  const choice = await chooseBlueprint(options.product, { client, drafter });
  for (const note of choice.notes) console.log(note);

  console.log(`\nChecking coverage for ${options.domains.length} account(s) (free people counts)...\n`);
  const plan = await buildCoverage(client, options.domains, choice.blueprint);
  console.log(formatCoverage(plan));

  const estimate = estimateCredits(plan, { workforce: options.workforce });
  console.log(`\n${formatEstimate(estimate)}`);

  let map;
  if (!options.fetch) {
    console.log('Coverage only. Add --fetch to map people.');
  } else if (options.dryRun) {
    console.log(`Dry run: no paid calls made. --fetch would spend at most ${Math.min(estimate.maxCredits, options.maxCredits)} credits (cap ${options.maxCredits}).`);
  } else if (plan.accounts.length === 0) {
    console.log('No accounts resolved, nothing to map.');
  } else {
    if (estimate.maxCredits > options.maxCredits) {
      console.log(`The cap is ${options.maxCredits} credits, below the ${estimate.maxCredits} worst case; roles that do not fit are skipped.`);
    }
    map = await mapCommittee(client, plan, { workforce: options.workforce, budget: new CreditBudget(options.maxCredits) });
    console.log(formatCommittee(map));
    console.log(`\nCredits charged for people searches and workforce checks: ${map.creditsSpent}.`);
    if (map.stoppedEarly) {
      // Keep what was already paid for: the report below is still written.
      console.error(`\nStopped early: ${map.stoppedEarly}`);
      process.exitCode = 1;
    }
  }

  await writeReport(options.outDir, {
    markdown: reportMarkdown({ plan, notes: choice.notes, estimate, map, creditsSpent: map?.creditsSpent ?? 0 }),
    csv: map ? committeeCsv(map) : coverageCsv(plan),
  });
}

async function runReveal(client: EnrichClient, options: CliOptions): Promise<void> {
  const { personId, domain } = options.revealEmail!;
  if (options.dryRun) {
    console.log(`Dry run: revealing this email would cost up to ${PRICES.emailFound} credits.`);
    return;
  }
  const result = await revealEmail(client, personId, domain, new CreditBudget(options.maxCredits));
  if (result.status === 'found') console.log(`Email: ${result.email} (certainty: ${result.certainty ?? 'unknown'})`);
  else console.log(`No email: status ${result.status}.`);
}

async function writeReport(outDir: string, files: { markdown: string; csv: string }): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const base = join(outDir, `committee-${date}`);
  await writeFile(`${base}.md`, files.markdown);
  await writeFile(`${base}.csv`, files.csv);
  console.log(`\nWrote ${base}.md and ${base}.csv`);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

main().catch((error: unknown) => {
  console.error(`Error: ${describeError(error)}`);
  process.exitCode = 1;
});
