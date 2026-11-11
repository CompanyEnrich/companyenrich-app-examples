import { existsSync } from 'node:fs';
import { CompanyEnrich } from '@companyenrich/sdk';
import { describeError, UsageError } from './lib/errors.js';
import { parseCliArgs, USAGE } from './lib/options.js';
import { runPipeline, type RunRecord } from './lib/pipeline.js';

function printSummary(run: RunRecord): void {
  const { spent, balanceBefore, balanceAfter } = run.credits;
  const format = (value: number) => value.toLocaleString('en-US');
  console.log('');
  if (run.status === 'stopped-by-budget') console.log(run.note);
  console.log(`Wrote ${run.files.join(', ')} to ${run.outputDir}`);
  console.log(
    `${run.status === 'dry-run' ? 'Dry run: ' : ''}${spent} credits charged by this run` +
      (balanceBefore !== undefined && balanceAfter !== undefined ? ` (balance ${format(balanceBefore)} -> ${format(balanceAfter)})` : ''),
  );
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (!options) {
    console.log(USAGE);
    return;
  }
  if (existsSync('.env')) process.loadEnvFile('.env'); // variables already set in the shell win
  if (!process.env.COMPANYENRICH_API_KEY) {
    throw new UsageError('Missing COMPANYENRICH_API_KEY. Create a key at https://companyenrich.com/dashboard and export it, or put it in .env.');
  }

  // Counts fan out 4 at a time; extra retries give the SDK's 429 backoff more room.
  const client = new CompanyEnrich({ timeoutMs: 30_000, maxRetries: 4 });
  const run = await runPipeline(options, { client, log: (line) => console.log(line) });
  printSummary(run);
  if (run.status === 'stopped-by-budget') process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = describeError(error);
  if (message === undefined) throw error;
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
