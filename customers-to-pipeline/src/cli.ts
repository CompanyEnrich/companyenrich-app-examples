import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
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
import { BudgetExceededError } from './lib/credits.js';
import { isPersona, PERSONAS } from './lib/people.js';
import { UsageError } from './lib/errors.js';
import { runPipeline, type PipelineOptions, type RunRecord } from './lib/pipeline.js';

const USAGE = `Usage: npm start -- <customers.csv> [options]

  --accounts <n>      lookalike accounts to fetch, 5 credits each (default 5, max 100)
  --contacts <n>      people to fetch across those accounts, 2 credits each (default 5, max 100)
  --persona <name>    ${Object.keys(PERSONAS).join(' | ')} (default sales-leader)
  --with-tech         add technologies to enrichment and the ICP (+1 credit per customer)
  --icp <file>        reuse an edited icp.json and skip profiling
  --min-share <0-1>   share of customers a value needs to join the ICP (default 0.3)
  --max-credits <n>   stop before any paid step that would take the run past this (default 60)
  --dry-run           spend nothing: free counts and a cost estimate only
  --out <dir>         output folder (default output)
  -h, --help          show this help`;

function integer(value: string, flag: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`${flag} must be a whole number from ${min} to ${max}, got "${value}".`);
  }
  return parsed;
}

const FLAGS = {
  accounts: { type: 'string', default: '5' },
  contacts: { type: 'string', default: '5' },
  persona: { type: 'string', default: 'sales-leader' },
  'with-tech': { type: 'boolean', default: false },
  icp: { type: 'string' },
  'min-share': { type: 'string', default: '0.3' },
  'max-credits': { type: 'string', default: '60' },
  'dry-run': { type: 'boolean', default: false },
  out: { type: 'string', default: 'output' },
  help: { type: 'boolean', short: 'h', default: false },
} as const satisfies ParseArgsOptionsConfig;

function readArgs(argv: string[]) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, options: FLAGS });
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${USAGE}`); // unknown flag or missing value
  }
}

function parseOptions(argv: string[]): PipelineOptions | undefined {
  const { values, positionals } = readArgs(argv);
  if (values.help) return undefined;

  const [csvPath, ...extra] = positionals;
  if (!csvPath || extra.length > 0) throw new UsageError(`Pass exactly one customers CSV.\n\n${USAGE}`);
  if (!isPersona(values.persona)) {
    throw new UsageError(`--persona must be one of ${Object.keys(PERSONAS).join(', ')}, got "${values.persona}".`);
  }
  const minShare = Number(values['min-share']);
  if (!(minShare > 0 && minShare <= 1)) throw new UsageError(`--min-share must be above 0 and at most 1, got "${values['min-share']}".`);

  return {
    csvPath,
    accounts: integer(values.accounts, '--accounts', 1, 100),
    contacts: integer(values.contacts, '--contacts', 0, 100),
    persona: values.persona,
    withTech: values['with-tech'],
    icpPath: values.icp,
    minShare,
    maxCredits: integer(values['max-credits'], '--max-credits', 0, 100_000),
    dryRun: values['dry-run'],
    outDir: values.out,
  };
}

function printSummary(run: RunRecord): void {
  const { spent, balanceBefore, balanceAfter } = run.credits;
  const format = (value: number) => value.toLocaleString('en-US');
  console.log('');
  if (run.files.length > 0) console.log(`Wrote ${run.files.join(', ')} to ${run.outputDir}`);
  const balance = balanceBefore !== undefined && balanceAfter !== undefined ? ` (balance ${format(balanceBefore)} -> ${format(balanceAfter)})` : '';
  console.log(`${run.status === 'dry-run' ? 'Dry run: ' : ''}${spent} credits charged by this run${balance}`);
}

/** Expected failures become one clear line; anything else keeps its stack trace. */
function describeError(error: unknown): string | undefined {
  if (error instanceof UsageError || error instanceof BudgetExceededError) return error.message;
  if (error instanceof AuthenticationError) {
    return 'CompanyEnrich rejected the API key (401). Check COMPANYENRICH_API_KEY; keys are at https://companyenrich.com/dashboard';
  }
  if (error instanceof PaymentRequiredError) return `Not enough credits, or the plan does not include this request (402): ${error.detail ?? ''}`;
  if (error instanceof PermissionDeniedError) return `The plan does not allow this request (403): ${error.detail ?? ''}`;
  if (error instanceof RateLimitError) return 'Rate limited (429) after retries. Wait a minute and re-run; cached enrichment is not billed again.';
  if (error instanceof BadRequestError || error instanceof ValidationError) {
    const fields = Object.entries(error.errors ?? {}).map(([field, messages]) => `${field}: ${messages.join(' ')}`);
    const detail = [error.detail ?? error.title ?? 'invalid request', ...fields].join('; ');
    return `The API rejected the request (${error.status}): ${detail}. If you passed --icp, check the filter in that file.`;
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
  if (!process.env.COMPANYENRICH_API_KEY) {
    throw new UsageError('Missing COMPANYENRICH_API_KEY. Create a key at https://companyenrich.com/dashboard and export it.');
  }
  // Paid calls here are POSTs, which the SDK never retries after an ambiguous failure, so one
  // estimate can never be billed twice. A 30 s timeout keeps a stalled request from hanging the run.
  const client = new CompanyEnrich({ timeoutMs: 30_000 });
  const run = await runPipeline(options, { client, log: (line) => console.log(line) });
  printSummary(run);
}

main().catch((error: unknown) => {
  const message = describeError(error);
  if (message === undefined) throw error;
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
