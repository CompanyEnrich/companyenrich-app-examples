import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { CompanyEnrich } from '@companyenrich/sdk';
import { resumeCommand } from './lib/command.js';
import { FileCache } from './lib/file-cache.js';
import { describeError, UsageError } from './lib/errors.js';
import { loadIcp } from './lib/icp.js';
import { writeOutputs } from './lib/outputs.js';
import { runPlanner, type PlannerOptions } from './lib/planner.js';
import { MAX_TERRITORIES } from './lib/report-html.js';
import { SAMPLE_TTL_MS, type SampleResult } from './lib/sample.js';
import { MIN_TERRITORIES } from './lib/territories.js';
import { territoryTable, textBars, textSamples, textTileMap } from './lib/report-text.js';
import { WEIGHT_MODES, type WeightBy } from './lib/weights.js';

const USAGE = `Usage: npm start -- --icp <file> [options]

Splits a country into sales territories with a balanced number of ICP companies, using free
CompanyEnrich counts. The default run costs 0 credits; only --sample spends credits.

  --icp <file>          ICP company filter as JSON (a v2 CompanySearchFilter), e.g. examples/icp.json
  --country <code>      two-letter country code (default US)
  --territories <n>     number of territories, ${MIN_TERRITORIES}-${MAX_TERRITORIES} (default 4, or one per rep)
  --reps "<a,b,...>"    rep names, one per territory, assigned west to east
  --weight-by <mode>    none | revenue | employees (default none): balance estimated revenue or headcount
  --keep-regions        US only: keep each Census division in one territory where balance allows
  --sample <n>          fetch n example accounts per territory with paid searches, 1 credit each (default 0)
  --max-credits <n>     refuse a --sample that could cost more than this (default 20)
  --dry-run             free calls only; print what --sample would cost instead of fetching
  --refresh             ignore cached counts (counts are cached for a day; paid samples are always reused)
  --out <dir>           output folder (default output)
  -h, --help            show this help`;

const FLAGS = {
  icp: { type: 'string' },
  country: { type: 'string', default: 'US' },
  territories: { type: 'string' },
  reps: { type: 'string' },
  'weight-by': { type: 'string', default: 'none' },
  'keep-regions': { type: 'boolean', default: false },
  sample: { type: 'string', default: '0' },
  'max-credits': { type: 'string', default: '20' },
  'dry-run': { type: 'boolean', default: false },
  refresh: { type: 'boolean', default: false },
  out: { type: 'string', default: 'output' },
  help: { type: 'boolean', short: 'h', default: false },
} as const satisfies ParseArgsOptionsConfig;

interface CliOptions extends Omit<PlannerOptions, 'icp' | 'cache' | 'sampleStore' | 'runId' | 'now'> {
  icpPath: string;
  refresh: boolean;
  out: string;
}

function integer(value: string, flag: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`${flag} must be a whole number from ${min} to ${max}, got "${value}".`);
  }
  return parsed;
}

function readArgs(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: FLAGS, allowPositionals: false });
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${USAGE}`); // unknown flag or missing value
  }
}

function parseOptions(argv: string[]): CliOptions | null {
  const { values } = readArgs(argv);
  if (values.help) return null;
  if (!values.icp) throw new UsageError(`Pass an ICP filter file with --icp, e.g. --icp examples/icp.json.\n\n${USAGE}`);

  const country = values.country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new UsageError(`--country must be a two-letter code such as US or DE, got "${values.country}".`);

  const reps = (values.reps ?? '').split(',').map((rep) => rep.trim()).filter(Boolean);
  const territories = values.territories !== undefined
    ? integer(values.territories, '--territories', MIN_TERRITORIES, MAX_TERRITORIES)
    : reps.length > 0 ? reps.length : 4;
  if (reps.length > 0 && reps.length !== territories) {
    throw new UsageError(`--reps lists ${reps.length} names but --territories is ${territories}. Give one rep per territory.`);
  }
  if (territories < MIN_TERRITORIES || territories > MAX_TERRITORIES) {
    throw new UsageError(`Plan between ${MIN_TERRITORIES} and ${MAX_TERRITORIES} territories; --reps gave ${territories}.`);
  }

  const weightBy = values['weight-by'] as WeightBy;
  if (!WEIGHT_MODES.includes(weightBy)) {
    throw new UsageError(`--weight-by must be one of ${WEIGHT_MODES.join(', ')}, got "${values['weight-by']}".`);
  }

  return {
    icpPath: values.icp,
    country,
    territories,
    reps,
    weightBy,
    keepRegions: values['keep-regions'],
    sample: integer(values.sample, '--sample', 0, 25),
    maxCredits: integer(values['max-credits'], '--max-credits', 0, 100_000),
    dryRun: values['dry-run'],
    refresh: values.refresh,
    out: values.out,
  };
}

/** 2026-11-11T10:45:03Z -> 20261111-104503 */
function timestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
}

/** A progress line that rewrites itself on a terminal and stays quiet in logs until it finishes. */
function progressLine() {
  let open = false;
  return {
    update(done: number, total: number) {
      if (process.stderr.isTTY) {
        process.stderr.write(`\r  counted ${done}/${total}`);
        open = done < total;
        if (!open) process.stderr.write('\n');
      } else if (done === total) {
        process.stderr.write(`  counted ${done}/${total}\n`);
      }
    },
    close() {
      if (open) process.stderr.write('\n');
      open = false;
    },
  };
}

async function main(argv: string[]): Promise<void> {
  const options = parseOptions(argv);
  if (!options) {
    console.log(USAGE);
    return;
  }
  if (existsSync('.env')) process.loadEnvFile('.env');
  if (!process.env.COMPANYENRICH_API_KEY) {
    throw new UsageError('Set COMPANYENRICH_API_KEY (in your shell or a .env file). Create a key at https://companyenrich.com/dashboard.');
  }
  const icp = await loadIcp(options.icpPath);
  const client = new CompanyEnrich({ timeoutMs: 30_000, maxRetries: 4 });
  const cache = await FileCache.open<number>(join(options.out, '.cache', 'counts.json'), { refresh: options.refresh });
  const samplesFile = join(options.out, '.cache', 'samples.json');
  const sampleStore = await FileCache.open<SampleResult>(samplesFile, { ttlMs: SAMPLE_TTL_MS });
  const now = new Date();
  const runId = `${timestamp(now)}-${options.country.toLowerCase()}-${options.territories}t`;

  const progress = progressLine();
  let report;
  try {
    report = await runPlanner(
      client,
      { ...options, icp, cache, sampleStore, runId, now },
      { info: (message) => console.error(message), progress: progress.update },
    );
  } finally {
    progress.close();
  }
  const paths = await writeOutputs(report, options.out);

  console.log(`\n${territoryTable(report)}\n`);
  console.log(report.country.code === 'US' ? textTileMap(report) : textBars(report));
  const samples = textSamples(report);
  if (samples) console.log(`\n${samples}`);
  console.log(`\nCredits spent: ${report.credits.spent}${report.credits.spent === 0 ? ' (free counts only)' : ''}.`);
  console.log(`Report:     ${paths.html}\nAssignment: ${paths.json}\nCSV:        ${paths.csv}`);
  if (report.credits.sampleFailed) {
    // The outputs above and the saved samples already record what was paid for.
    console.error(`Error: ${report.credits.sampleNote}`);
    console.error(`Finished territories are saved in ${samplesFile}. To fetch only the rest, run:\n  ${resumeCommand(argv)}`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = describeError(error);
  console.error(message ? `Error: ${message}` : error);
  process.exitCode = 1;
});
