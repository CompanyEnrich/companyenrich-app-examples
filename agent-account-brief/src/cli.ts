import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { CompanyEnrich } from '@companyenrich/sdk';
import { DEFAULT_MODEL, runAgent } from './lib/agent';
import { CreditBudget } from './lib/budget';
import { BriefError, describeError } from './lib/errors';
import type { Target } from './lib/input';
import { parseOptions, USAGE, UsageError, type Options } from './lib/options';
import { runPipeline } from './lib/pipeline';
import { assembleBrief, renderBrief, renderLedger } from './lib/render';
import {
  createToolContext,
  currentCompanyDomain,
  type EnrichCompanyResult,
  type PersonLookupResult,
  type ToolCallRecord,
  type ToolContext,
} from './lib/tools';

// The brief goes to stdout; progress and notices go to stderr.
const log = (line: string) => console.error(line);

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const options = parseOptions(process.argv.slice(2), process.env);
  if (!options) {
    console.log(USAGE);
    return;
  }
  if (!process.env.COMPANYENRICH_API_KEY) {
    throw new UsageError('Set COMPANYENRICH_API_KEY first. Get a key at https://companyenrich.com/dashboard');
  }
  if (options.notice) log(options.notice);

  const client = new CompanyEnrich({ timeoutMs: 30_000 });
  const budget = new CreditBudget(options.maxCredits);
  const ctx = createToolContext({ client, budget, dryRun: options.dryRun, log: (line) => log(`  ${line}`) });
  const before = await balance(client); // me() is free; it also fails fast on a bad key.

  if (options.dryRun) {
    await dryRun(ctx, options, before);
    return;
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  log(`Researching ${describe(options.target)} (${options.mode} mode, ${options.depth} depth, cap ${options.maxCredits} credits)`);
  let body: string;
  let domain: string;
  let engine: string;
  try {
    if (options.mode === 'pipeline') {
      const result = await runPipeline(ctx, options.target, options.depth);
      if (result.status !== 'ok') throw new BriefError(result.status === 'error' ? result.error : 'no company data returned');
      body = renderBrief(result.research, now);
      domain = result.research.domain;
      engine = 'pipeline mode (rule-based)';
    } else {
      const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
      body = await runAgent({ anthropic: new Anthropic(), ctx, target: options.target, depth: options.depth, model, today });
      domain = researchedDomain(options.target, ctx.calls);
      engine = `agent mode (${model})`;
    }
  } catch (error) {
    await reportSpend(client, budget, before);
    throw error;
  }

  const after = await balance(client);
  const runLine = `Generated ${today} by agent-account-brief: ${engine}, ${options.depth} depth, CompanyEnrich data only.`;
  const brief = assembleBrief({ body, runLine, calls: ctx.calls, budget, balance: { before, after } });
  const file = join(options.outDir, `${domain}-${today.replaceAll('-', '')}.md`);
  await mkdir(options.outDir, { recursive: true });
  await writeFile(file, brief);
  console.log(brief);
  log(`Saved ${file}`);
}

/** Runs the pipeline plan with paid calls replaced by reservations, then shows the ledger. Spends nothing. */
async function dryRun(ctx: ToolContext, options: Options, before: number): Promise<void> {
  log(`Dry run for ${describe(options.target)} at ${options.depth} depth: free endpoints only.`);
  if (options.mode === 'agent') {
    log('Agent mode picks its calls at run time. This estimates the pipeline plan for the same depth; --max-credits caps both.');
  }
  const result = await runPipeline(ctx, options.target, options.depth);
  if (result.status === 'error') throw new BriefError(result.error);
  const after = await balance(ctx.client);
  console.log(`# Dry run: ${describe(options.target)}, ${options.depth} depth\n\n${renderLedger(ctx.budget, { before, after }, true)}`);
}

/** When a run stops early, show what it had already reserved and spent before the error. */
async function reportSpend(client: CompanyEnrich, budget: CreditBudget, before: number): Promise<void> {
  if (budget.reserved === 0) return;
  const after = await balance(client).catch(() => undefined);
  log(`The run stopped early. Credits reserved before it stopped:\n${renderLedger(budget, after === undefined ? undefined : { before, after })}`);
}

/** Available credits, from the free me() endpoint. */
async function balance(client: CompanyEnrich): Promise<number> {
  const { credits } = await client.me();
  return credits.total - credits.used;
}

/** The company the agent researched: the first one it enriched, else the company behind the input email. */
function researchedDomain(target: Target, calls: ToolCallRecord[]): string {
  const enriched = calls.find((call) => call.tool === 'enrich_company');
  if (enriched) return (enriched.result as EnrichCompanyResult).company.domain;
  const lookup = calls.find((call) => call.tool === 'lookup_person_by_email');
  const fromEmail = lookup && currentCompanyDomain((lookup.result as PersonLookupResult).person);
  return fromEmail ?? (target.kind === 'domain' ? target.domain : target.emailDomain);
}

function describe(target: Target): string {
  return target.kind === 'domain' ? target.domain : target.email;
}

main().catch((error: unknown) => {
  const message = describeError(error);
  if (message) console.error(`Error: ${message}`);
  else console.error(error);
  process.exitCode = 1;
});
