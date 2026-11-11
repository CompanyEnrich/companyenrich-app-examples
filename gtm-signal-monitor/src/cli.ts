import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CompanyEnrich } from '@companyenrich/sdk';
import { ConfigError, loadConfig } from './lib/config.js';
import { describeError } from './lib/errors.js';
import { runMonitor } from './lib/run.js';
import { StateError } from './lib/state.js';

const USAGE = `Usage: npm start -- [options]

Options:
  --watcher <id>       Run only this watcher (repeat for several)
  --dry-run            Free calls only: print the credit plan, change nothing
  --max-credits <n>    Most credits one run may spend (default 50)
  --config <file>      Config file (default monitor.config.yaml)
  --reset-state        Forget what the selected watchers have seen and start over
  -h, --help           Show this help`;

const STATE_PATH = 'state/state.json';
const OUTPUT_DIR = 'output';
const DEFAULT_MAX_CREDITS = 50;

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      options: {
        watcher: { type: 'string', multiple: true },
        'dry-run': { type: 'boolean', default: false },
        'max-credits': { type: 'string' },
        config: { type: 'string', default: 'monitor.config.yaml' },
        'reset-state': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values;
  } catch (error) {
    console.error(`${describeError(error)}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const maxCredits = args['max-credits'] === undefined ? DEFAULT_MAX_CREDITS : Number(args['max-credits']);
  if (!Number.isInteger(maxCredits) || maxCredits < 0) {
    console.error('--max-credits must be a whole number of 0 or more.');
    return 2;
  }

  // Lets local and cron runs keep the key in .env. Variables already set in the environment win.
  if (existsSync('.env')) process.loadEnvFile('.env');
  if (!process.env.COMPANYENRICH_API_KEY) {
    console.error(
      'COMPANYENRICH_API_KEY is not set. Create a key at https://companyenrich.com/dashboard, then export it or add it to .env.',
    );
    return 1;
  }

  try {
    const config = loadConfig(args.config);
    const result = await runMonitor({
      // The paid calls here are all POSTs, which the SDK never retries after an ambiguous failure,
      // so there is no paid GET that would need `{ maxRetries: 0 }`.
      client: new CompanyEnrich({ timeoutMs: 30_000 }),
      config,
      statePath: STATE_PATH,
      outputDir: OUTPUT_DIR,
      maxCredits,
      dryRun: args['dry-run'],
      resetState: args['reset-state'],
      watcherIds: args.watcher,
      slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || undefined,
    });
    return result.failed ? 1 : 0;
  } catch (error) {
    const expected = error instanceof ConfigError || error instanceof StateError;
    console.error(expected ? error.message : describeError(error));
    return 1;
  }
}

process.exitCode = await main();
