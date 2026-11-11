import { parseArgs } from 'node:util';
import { CompanyEnrich } from '@companyenrich/sdk';
import { runApply } from './lib/apply.js';
import { describeError, UserError } from './lib/errors.js';
import { runDiff } from './lib/pipeline.js';
import { ACTIONS, CHANGE_TYPES } from './lib/report.js';

const USAGE = `Usage:
  npm start -- diff <crm-export.csv> [--mapping mapping.example.json] [--rules rules.example.json]
                    [--max-credits 60] [--dry-run] [--bulk] [--batch <id>] [--out output]
  npm start -- apply <approved-patch.csv> --hubspot [--execute] [--mapping mapping.example.json] [--out output]`;

function parseCli(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        mapping: { type: 'string', default: 'mapping.example.json' },
        rules: { type: 'string', default: 'rules.example.json' },
        'max-credits': { type: 'string', default: '60' },
        'dry-run': { type: 'boolean', default: false },
        bulk: { type: 'boolean', default: false },
        batch: { type: 'string' },
        out: { type: 'string', default: 'output' },
        hubspot: { type: 'boolean', default: false },
        execute: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new UserError(`${(error as Error).message}\n${USAGE}`);
  }
}

function createClient(): CompanyEnrich {
  if (!process.env.COMPANYENRICH_API_KEY) {
    throw new UserError('Set COMPANYENRICH_API_KEY to your API key. Create one at https://companyenrich.com/dashboard');
  }
  // The API is sometimes slow on large batches, so allow 30 seconds per attempt.
  return new CompanyEnrich({ timeoutMs: 30_000 });
}

async function diffCommand(csvPath: string, values: ReturnType<typeof parseCli>['values']): Promise<void> {
  const maxCredits = Number(values['max-credits']);
  if (!Number.isInteger(maxCredits) || maxCredits < 0) throw new UserError('--max-credits must be a whole number, 0 or more');

  const result = await runDiff(
    {
      csvPath,
      mappingPath: values.mapping,
      rulesPath: values.rules,
      outDir: values.out,
      maxCredits,
      dryRun: values['dry-run'],
      forceBulk: values.bulk,
      ...(values.batch ? { batchId: values.batch } : {}),
    },
    { createClient, hasApiKey: Boolean(process.env.COMPANYENRICH_API_KEY), log: console.log },
  );
  if (result.kind === 'dry-run') return;

  const { counts, records } = result.report;
  const diffed = records.filter((record) => record.status === 'found').length;
  console.log(`\nDiff: ${result.cells.length} cells across ${diffed} enriched records`);
  console.log(`  ${CHANGE_TYPES.map((change) => `${change} ${counts.byChange[change]}`).join(' · ')}`);
  console.log(`Proposed: ${ACTIONS.filter((action) => action !== 'none').map((action) => `${action} ${counts.byAction[action]}`).join(' · ')}`);
  console.log(`\nWrote ${result.runDir}/`);
  console.log('  review.html  open in a browser to approve or reject changes, then export the approved patch');
  console.log(`  patch.csv    ${counts.byAction.update} proposed updates`);
  console.log('  summary.md   counts by change type and field');
  console.log('  run.json     run ledger: credits, cache use and enrichment statuses');
}

async function applyCommand(patchPath: string, values: ReturnType<typeof parseCli>['values']): Promise<void> {
  if (!values.hubspot) throw new UserError('Choose where to apply the patch. Only --hubspot is supported.');
  await runApply(
    { patchPath, mappingPath: values.mapping, execute: values.execute, outDir: values.out },
    { token: process.env.HUBSPOT_TOKEN, log: console.log },
  );
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseCli(argv);
  const [command, file] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  if (!file) throw new UserError(`Missing the CSV file for "${command}".\n${USAGE}`);
  if (command === 'diff') return diffCommand(file, values);
  if (command === 'apply') return applyCommand(file, values);
  throw new UserError(`Unknown command "${command}".\n${USAGE}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = describeError(error);
  if (message === null) throw error;
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
