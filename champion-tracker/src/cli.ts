import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CompanyEnrich } from '@companyenrich/sdk';
import { runCheck } from './lib/check.js';
import { ConfigError, EXAMPLE_CONFIG_PATH, loadConfig, resolveConfigPath } from './lib/config.js';
import { CsvError, readChampionsCsv } from './lib/csv.js';
import { describeError } from './lib/errors.js';
import { runInit } from './lib/init.js';
import { DEFAULT_CHECK_EVERY_DAYS } from './lib/schedule.js';
import { DEFAULT_STATE_PATH, StateError } from './lib/state.js';

const USAGE = `Usage:
  npm start -- init <champions.csv> [--max-credits 100] [--dry-run]
  npm start -- check [--max-credits 40] [--check-every-days 30 | --pending-only] [--with-contacts] [--dry-run]

Options:
  --max-credits <n>        Most credits this run may spend (init: 100, check: 40)
  --dry-run                Print the plan and estimated cost; no paid calls, no files written
  --check-every-days <n>   check: days between checks of the same champion (default 30; 0 = everyone now)
  --pending-only           check: only champions a capped or stopped run left pending, whatever the interval
  --with-contacts          check: also fetch up to 3 buyer-persona contacts per new company (2 credits each)
  --config <file>          check: ICP config (default config/icp.json, else config/icp.example.json)
  --state <file>           State file (default ${DEFAULT_STATE_PATH})
  -h, --help               Show this help`;

const DEFAULT_MAX_CREDITS = { init: 100, check: 40 };
const OUTPUT_DIR = 'output';

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        'max-credits': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'check-every-days': { type: 'string' },
        'pending-only': { type: 'boolean', default: false },
        'with-contacts': { type: 'boolean', default: false },
        config: { type: 'string' },
        state: { type: 'string', default: DEFAULT_STATE_PATH },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    console.error(`${describeError(error)}\n\n${USAGE}`);
    return 2;
  }
  const { values: args, positionals } = parsed;
  const [command, csvPath] = positionals;
  if (args.help || !command) {
    console.log(USAGE);
    return args.help ? 0 : 2;
  }
  if (command !== 'init' && command !== 'check') {
    console.error(`Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  }
  if (command === 'init' && !csvPath) {
    console.error(`init needs the path to your champions CSV.\n\n${USAGE}`);
    return 2;
  }

  const maxCredits = wholeNumber(args['max-credits'], DEFAULT_MAX_CREDITS[command], '--max-credits');
  const checkEveryDays = wholeNumber(args['check-every-days'], DEFAULT_CHECK_EVERY_DAYS, '--check-every-days');
  if (maxCredits === null || checkEveryDays === null) return 2;

  // Lets local runs keep the key in .env. Variables already set in the environment win.
  if (existsSync('.env')) process.loadEnvFile('.env');
  const apiKey = process.env.COMPANYENRICH_API_KEY;
  if (!apiKey) {
    console.error('COMPANYENRICH_API_KEY is not set. Create a key at https://companyenrich.com/dashboard, then export it or add it to .env.');
    return 1;
  }
  // The API can be slow on cold lookups; 30 seconds per attempt fails faster than the SDK's 2-minute default.
  const client = new CompanyEnrich({ apiKey, timeoutMs: 30_000 });

  try {
    if (command === 'init') {
      const rows = readChampionsCsv(csvPath!);
      const summary = await runInit({ client, rows, csvPath: csvPath!, statePath: args.state, maxCredits, dryRun: args['dry-run'] });
      return summary.stoppedBy ? 1 : 0;
    }

    // Every input is validated before the first API call, so a typo never costs credits.
    const configPath = resolveConfigPath(args.config);
    const config = loadConfig(configPath);
    if (configPath === EXAMPLE_CONFIG_PATH) console.log(`Using ${configPath}. Copy it to config/icp.json to describe your own ICP.`);
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || undefined;
    if (slackWebhookUrl && !/^https?:$/.test(URL.parse(slackWebhookUrl)?.protocol ?? '')) {
      console.error('SLACK_WEBHOOK_URL is not a valid http(s) URL. Fix it, or unset it to skip Slack.');
      return 1;
    }
    const result = await runCheck({
      client,
      config,
      statePath: args.state,
      outputDir: OUTPUT_DIR,
      maxCredits,
      checkEveryDays,
      pendingOnly: args['pending-only'],
      withContacts: args['with-contacts'],
      dryRun: args['dry-run'],
      configPath: args.config,
      slackWebhookUrl,
    });
    return result.report?.stoppedBy || result.deliveryErrors.length > 0 ? 1 : 0;
  } catch (error) {
    const expected = error instanceof ConfigError || error instanceof CsvError || error instanceof StateError;
    console.error(expected ? error.message : describeError(error));
    return 1;
  }
}

function wholeNumber(value: string | undefined, fallback: number, flag: string): number | null {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (Number.isInteger(number) && number >= 0) return number;
  console.error(`${flag} must be a whole number of 0 or more.`);
  return null;
}

process.exitCode = await main();
