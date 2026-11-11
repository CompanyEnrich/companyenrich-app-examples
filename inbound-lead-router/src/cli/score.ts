import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { runBatch, type BatchRun } from '../lib/batch';
import { apiCaller, API_CONCURRENCY, createClient } from '../lib/client';
import { Limiter } from '../lib/concurrency';
import { loadPipelineConfig } from '../lib/config-files';
import { describeApiError } from '../lib/errors';
import { plural } from '../lib/format';
import { leadsToCsv, planLeadCsv, scoreLeads } from '../lib/lead-csv';
import { openCompanyCache } from '../lib/state';

// npm run score -- leads.csv [--dry-run] [--max-credits 100] [--out file.csv]
// Scores a CSV of signups with the same scoring and routing config as the webhook.

const USAGE = `Usage: npm run score -- <leads.csv> [options]

Options:
  --dry-run            Plan and price the run without calling the API (0 credits)
  --max-credits <n>    Spend at most n credits; rows beyond it are skipped (default 100)
  --out <file>         Output path (default output/scored-<date>.csv)
  --scoring <file>     Scoring config (default config/scoring.json)
  --routing <file>     Routing config (default config/routing.json)
  -h, --help           Show this help`;

class UsageError extends Error {}

function parseCli(args: string[]) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: {
        'dry-run': { type: 'boolean', default: false },
        'max-credits': { type: 'string', default: '100' },
        out: { type: 'string' },
        scoring: { type: 'string' },
        routing: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

async function main(): Promise<void> {
  // Same key file as the web app. Variables already set in the shell win.
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  const { values, positionals } = parseCli(process.argv.slice(2));
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const file = positionals[0];
  if (!file || positionals.length > 1) throw new UsageError('Pass exactly one CSV file.');
  if (!existsSync(file)) throw new UsageError(`File not found: ${file}`);
  const maxCredits = Number(values['max-credits']);
  if (!Number.isInteger(maxCredits) || maxCredits < 0) throw new UsageError('--max-credits must be a whole number.');

  // Validate everything (configs, CSV, output folder) before the first paid call.
  const config = loadPipelineConfig({ scoring: values.scoring, routing: values.routing });
  const cache = openCompanyCache();
  const now = new Date();
  const planned = planLeadCsv(readFileSync(file, 'utf8'), cache, config, maxCredits);
  const out = values.out ?? join('output', `scored-${now.toISOString().slice(0, 10)}.csv`);
  mkdirSync(dirname(out), { recursive: true });
  const { plan } = planned;

  const count = (status: string) => plan.items.filter((item) => item.status === status).length;
  const overBudget = count('over-budget');
  console.log(`${plural(plan.items.length, 'lead')} in ${file} (email column "${planned.emailColumn}")`);
  console.log(`  free-mail, skipped:       ${count('free-mail')}`);
  console.log(`  invalid email, skipped:   ${count('invalid')}`);
  console.log(`  cached in the last 24 h:  ${count('cached')} (free)`);
  console.log(
    `  to enrich:                ${plural(plan.toEnrich.length, 'domain')} x ${plan.creditsPerCompany} credits` +
      ` (enrich${plan.expand.map((name) => ` + ${name}`).join('')}) = up to ${plan.maxCredits} credits`,
  );
  if (overBudget > 0) console.log(`  over --max-credits ${maxCredits}:   ${plural(overBudget, 'row')} will be skipped`);

  let run: BatchRun | null = null;
  if (values['dry-run']) {
    console.log('\nDry run: no API calls, 0 credits spent.');
  } else if (plan.toEnrich.length > 0) {
    const call = apiCaller(createClient, new Limiter(API_CONCURRENCY));
    console.log(`\nEnriching ${plural(plan.toEnrich.length, 'domain')} with companies.enrichBatch...`);
    run = await runBatch(call, cache, plan);
    const uncertain = run.uncertainCredits ? `, plus up to ${run.uncertainCredits} for requests that failed after sending` : '';
    console.log(`Spent ${run.credits} credits${uncertain} (estimate was up to ${plan.maxCredits}).`);
  } else {
    console.log('\nNothing to enrich: 0 credits spent.');
  }

  const leads = scoreLeads(planned, run, config, now);
  writeFileSync(out, leadsToCsv(planned, leads));

  console.log('');
  for (const lead of leads.slice(0, 25)) {
    const { score, tier, route } = lead.evaluation;
    const email = lead.record[planned.emailColumn] ?? '';
    const result = score ? `${String(score.total).padStart(5)}  ${(tier?.tier ?? '').padEnd(19)}` : `${''.padStart(5)}  ${lead.status.padEnd(19)}`;
    console.log(`  ${email.padEnd(32)} ${result}${lead.routed ? ` -> ${route.team}` : ''}`);
  }
  if (leads.length > 25) console.log(`  ... and ${leads.length - 25} more`);
  const tiers = ['A', 'B', 'C', 'unqualified'].map((tier) => `${tier}: ${leads.filter((lead) => lead.evaluation.tier?.tier === tier).length}`);
  console.log(`\nTiers: ${tiers.join(', ')}`);
  console.log(`Wrote ${out}`);

  if (run?.error) {
    console.error(`\nStopped early: ${run.error}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const message = describeApiError(error) ?? (error instanceof Error ? error.message : String(error));
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
