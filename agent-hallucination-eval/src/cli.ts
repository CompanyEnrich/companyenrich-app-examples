import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { EFFORTS, type Effort } from './lib/adapters/claude.ts';
import { createAdapter } from './lib/adapters/index.ts';
import { ADAPTER_NAMES, type AdapterName } from './lib/adapters/types.ts';
import { createCompanyEnrichClient } from './lib/clients.ts';
import { readDomainsFile } from './lib/domains.ts';
import { describeError, UsageError } from './lib/errors.ts';
import { enrichCachePath } from './lib/enrich-cache.ts';
import { buildEvalSet, CREDITS_PER_COMPANY, enrichWithCache, planGenerate, uncachedDomains } from './lib/generate.ts';
import { assertWritableFile, createJsonlWriter, readJsonl, writeJsonl } from './lib/jsonl.ts';
import { scoreRecords, type ScoredRow } from './lib/metrics.ts';
import { renderReport, renderSummary } from './lib/report.ts';
import { runEval } from './lib/run.ts';
import type { Question, RunRecord } from './lib/types.ts';

const HELP = `Usage:
  npm start -- generate [--domains data/domains.txt] [--max-credits 50] [--out data/eval-<date>.jsonl] [--dry-run]
  npm start -- run --model <adapter> [--questions <file>] [--limit n] [--effort medium] [--max-credits 50] [--out <file>] [--dry-run]
  npm start -- score <run files...> [--out report.md]

Adapters: ${ADAPTER_NAMES.join(', ')}`;

const today = () => new Date().toISOString().slice(0, 10);

function positiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} must be a positive whole number, got "${value}".`);
  return n;
}

async function generate(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      domains: { type: 'string', default: 'data/domains.txt' },
      'max-credits': { type: 'string', default: '50' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const maxCredits = positiveInt(values['max-credits'], '--max-credits');
  const domains = await readDomainsFile(values.domains);
  if (domains.length === 0) throw new UsageError(`No domains found in ${values.domains}.`);
  const out = values.out ?? `data/eval-${today()}.jsonl`;
  const cachePath = enrichCachePath(out);
  // Check every input and destination before the first paid call.
  await assertWritableFile(out);
  await assertWritableFile(cachePath);

  const todo = await uncachedDomains(domains, cachePath);
  const saved = domains.length - todo.length;
  const estimate = todo.length * CREDITS_PER_COMPANY;
  console.log(
    `${domains.length} domains${saved ? `, ${saved} already enriched in ${cachePath}` : ''}. ` +
      `Estimated cost: up to ${estimate} credits (${CREDITS_PER_COMPANY} per company found).`,
  );
  const client = createCompanyEnrichClient();

  if (values['dry-run']) {
    const plan = await planGenerate(client, todo);
    if (plan.unknownDomains.length > 0) {
      console.log(`Not found by autocomplete (likely no record, costs nothing): ${plan.unknownDomains.join(', ')}`);
    }
    console.log(`Balance: ${plan.creditsRemaining} credits. Dry run: 0 credits spent.`);
    return;
  }
  if (estimate > maxCredits) {
    throw new UsageError(`The estimate of ${estimate} credits is over --max-credits ${maxCredits}. Raise the cap or trim the list.`);
  }

  const ledger = { creditsSpent: 0 };
  try {
    const entries = await enrichWithCache(client, domains, cachePath, today(), ledger);
    for (const entry of entries) if (entry.status !== 'found') console.log(`Skipped ${entry.domain}: ${entry.status}`);
    if (!entries.some((entry) => entry.company)) throw new UsageError('No company was found, so there is nothing to ask about.');
    const questions = await buildEvalSet(client, entries);
    await writeJsonl(out, questions);

    const perField = new Map<string, number>();
    for (const q of questions) perField.set(q.field, (perField.get(q.field) ?? 0) + 1);
    const breakdown = [...perField].map(([field, count]) => `${field} ${count}`).join(', ');
    const companies = new Set(questions.map((q) => q.domain)).size;
    console.log(`${companies} companies, ${questions.length} questions (${breakdown}).`);
    console.log(`Wrote ${out}. Credits spent: ${ledger.creditsSpent}.`);
  } catch (error) {
    if (ledger.creditsSpent > 0) {
      console.error(
        `Spent ${ledger.creditsSpent} credits before this error. The paid results are saved in ${cachePath}. ` +
          `To resume without buying them twice, run: npm start -- generate --domains ${values.domains} --out ${out}`,
      );
    }
    throw error;
  }
}

/** The newest `data/eval-<date>.jsonl`, or the committed sample when none has been generated yet. */
async function defaultQuestionsFile(): Promise<string> {
  const files = (await readdir('data')).filter((f) => /^eval-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const latest = files.at(-1);
  if (latest) return `data/${latest}`;
  console.log('No generated eval set yet, using data/sample.jsonl. Run `npm start -- generate` for the full set.');
  return 'data/sample.jsonl';
}

function isAdapterName(name: string): name is AdapterName {
  return (ADAPTER_NAMES as readonly string[]).includes(name);
}

async function run(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      model: { type: 'string' },
      questions: { type: 'string' },
      limit: { type: 'string' },
      effort: { type: 'string', default: 'medium' },
      'max-credits': { type: 'string', default: '50' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const name = values.model ?? '';
  if (!isAdapterName(name)) throw new UsageError(`--model must be one of: ${ADAPTER_NAMES.join(', ')}.`);
  const effort = values.effort as Effort;
  if (!EFFORTS.includes(effort)) throw new UsageError(`--effort must be one of: ${EFFORTS.join(', ')}.`);
  const maxCredits = positiveInt(values['max-credits'], '--max-credits');

  const questionsPath = values.questions ?? (await defaultQuestionsFile());
  let questions = await readJsonl<Question>(questionsPath);
  if (values.limit) questions = questions.slice(0, positiveInt(values.limit, '--limit'));
  if (questions.length === 0) throw new UsageError(`No questions in ${questionsPath}.`);

  const domains = new Set(questions.map((q) => q.domain));
  const estimate = name === 'claude-with-companyenrich' ? domains.size * CREDITS_PER_COMPANY : 0;
  // The grounded adapter usually needs two requests per question: the tool call, then the answer.
  const requestsPerQuestion = name === 'claude-with-companyenrich' ? 2 : 1;
  const modelCalls = name.startsWith('claude') ? `, about ${questions.length * requestsPerQuestion} Claude requests` : '';
  console.log(`${name} on ${questions.length} questions from ${questionsPath}: up to ${estimate} CompanyEnrich credits${modelCalls}.`);
  if (values['dry-run']) {
    console.log('Dry run: nothing was called.');
    return;
  }
  if (estimate > maxCredits) {
    throw new UsageError(`The estimate of ${estimate} credits is over --max-credits ${maxCredits}. Raise the cap or use --limit.`);
  }

  const out = values.out ?? `runs/${name}-${today()}.jsonl`;
  await assertWritableFile(out);
  const { adapter, lookup } = await createAdapter(name, { effort, maxCredits });
  const write = await createJsonlWriter(out);
  let done = 0;
  try {
    const records = await runEval({
      adapter,
      questions,
      onRecord: async (record) => {
        await write(record);
        done += 1;
        if (done % 25 === 0 || done === questions.length) console.log(`  ${done}/${questions.length} answered`);
      },
    });
    console.log(`Wrote ${out}. ${records.filter((r) => r.error).length} errors.`);
    console.log(`Score it with: npm start -- score ${out}`);
  } finally {
    // Reported even when the run stops early, so the spend is never a surprise.
    if (lookup) {
      const uncertain = lookup.creditsUncertain ? ` (plus up to ${lookup.creditsUncertain} for failed requests that may have been billed)` : '';
      console.log(`enrich_company: ${lookup.apiCalls} API requests, ${lookup.creditsSpent} credits spent${uncertain}.`);
    }
  }
}

async function score(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { out: { type: 'string', default: 'report.md' } },
  });
  if (positionals.length === 0) throw new UsageError('Pass one or more run files, for example: npm start -- score runs/*.jsonl');

  const rows: ScoredRow[] = [];
  for (const file of positionals) {
    const records = await readJsonl<RunRecord>(file);
    rows.push(...scoreRecords(basename(file, '.jsonl'), records));
  }
  await writeFile(values.out, renderReport(rows, positionals, today()));
  console.log(renderSummary(rows));
  console.log(`Wrote ${values.out}.`);
}

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const [command, ...args] = process.argv.slice(2);
  if (command === 'generate') return generate(args);
  if (command === 'run') return run(args);
  if (command === 'score') return score(args);
  console.log(HELP);
  if (command && command !== 'help' && command !== '--help') process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`Error: ${describeError(error)}`);
  process.exitCode = 1;
});
