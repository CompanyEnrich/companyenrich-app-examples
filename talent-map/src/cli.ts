import { existsSync } from 'node:fs';
import {
  ApiError,
  AuthenticationError,
  BadRequestError,
  CompanyEnrich,
  CompanyEnrichError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  ValidationError,
} from '@companyenrich/sdk';
import { parseOptions, USAGE } from './lib/args.js';
import { BudgetExceededError } from './lib/credits.js';
import { UsageError } from './lib/errors.js';
import { prepareOutputDir, writeOutputs } from './lib/output.js';
import { buildTalentMap, RunStoppedError, type TalentMap } from './lib/talent-map.js';
import { describeTrend } from './lib/trends.js';

function printSummary(map: TalentMap, written: { dir: string; files: string[] }): void {
  const format = (value: number) => value.toLocaleString('en-US');
  console.log('');
  console.log(`Shortlist pool: ${format(map.sizing.target)} (${format(map.sizing.inEnvironment)} in this environment, ${format(map.sizing.market)} across all companies)`);
  const shown = map.companies.slice(0, 5);
  if (shown.length > 0) console.log(`Top companies (${shown.length} of ${map.companies.length} in the shortlist):`);
  for (const [index, row] of shown.entries()) {
    const text = row.trend ? describeTrend(row.trend) : undefined;
    const trend = text ? `, ${map.role.trendScope} team ${text.arrow} ${text.change} ${text.since}` : '';
    const pool = row.pool === undefined ? 'pool not counted' : `${format(row.pool)} matching`;
    console.log(`  ${index + 1}. ${row.company.name}: ${pool}, ${row.shortlisted} shortlisted${trend}`);
  }
  console.log(`Wrote ${written.files.join(', ')} to ${written.dir}`);
  const { spent, balanceBefore, balanceAfter } = map.credits;
  const balance = balanceBefore !== undefined && balanceAfter !== undefined ? ` (account balance ${format(balanceBefore)} -> ${format(balanceAfter)})` : '';
  const prefix = map.status === 'dry-run' ? 'Dry run: ' : map.status === 'stopped' ? 'Stopped early: ' : '';
  console.log(`${prefix}${spent} credits charged by this run${balance}`);
}

/** Expected failures become one clear line; anything else keeps its stack trace. */
function describeError(error: unknown): string | undefined {
  if (error instanceof UsageError || error instanceof BudgetExceededError) return error.message;
  if (error instanceof AuthenticationError) {
    return 'CompanyEnrich rejected the API key (401). Check COMPANYENRICH_API_KEY; keys are at https://companyenrich.com/dashboard';
  }
  if (error instanceof PaymentRequiredError) return `Not enough credits, or the plan does not include this request (402). ${error.detail ?? ''}`.trim();
  if (error instanceof PermissionDeniedError) return `The plan does not allow this request (403). ${error.detail ?? ''}`.trim();
  if (error instanceof RateLimitError) return 'Rate limited (429) after retries. Wait a minute and run again.';
  if (error instanceof BadRequestError || error instanceof ValidationError) {
    const fields = Object.entries(error.errors ?? {}).map(([field, messages]) => `${field}: ${messages.join(' ')}`);
    return `The API rejected the request (${error.status}): ${[error.detail ?? error.title ?? 'invalid request', ...fields].join('; ')}`;
  }
  if (error instanceof ApiError) return `CompanyEnrich API error ${error.status}: ${error.detail ?? error.title ?? ''} (trace ${error.traceId ?? 'n/a'})`;
  if (error instanceof CompanyEnrichError) return error.message; // connection problems and timeouts
  return undefined;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options) {
    console.log(USAGE);
    return;
  }
  if (existsSync('.env')) process.loadEnvFile('.env'); // variables already set in the shell win
  if (!process.env.COMPANYENRICH_API_KEY) {
    throw new UsageError('Missing COMPANYENRICH_API_KEY. Create a key at https://companyenrich.com/dashboard and export it.');
  }
  await prepareOutputDir(options.outDir); // fail now, not after paying for results we can't save
  const client = new CompanyEnrich({ timeoutMs: 30_000 });
  try {
    const map = await buildTalentMap(options, { client, log: (line) => console.log(line) });
    printSummary(map, await writeOutputs(map, options.outDir));
  } catch (error) {
    if (!(error instanceof RunStoppedError)) throw error;
    printSummary(error.map, await writeOutputs(error.map, options.outDir)); // keep what was paid for
    throw error.cause;
  }
}

main().catch((error: unknown) => {
  const message = describeError(error);
  if (message === undefined) throw error;
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
