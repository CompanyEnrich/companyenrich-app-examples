import { parseArgs } from 'node:util';
import { DEFAULT_PRESET_ID, PRESETS } from '../lib/blueprints';
import { parseDomainList } from '../lib/domains';
import { UserFacingError } from '../lib/user-error';

const DEFAULT_MAX_CREDITS = 40;

export interface CliOptions {
  domains: string[];
  product: string;
  fetch: boolean;
  workforce: boolean;
  maxCredits: number;
  dryRun: boolean;
  revealEmail: { personId: string; domain: string } | null;
  outDir: string;
  help: boolean;
}

export const USAGE = `Map the likely buying committee at target accounts.

Usage:
  npm run cli -- --domains stripe.com,posthog.com --product devtools [options]
  npm run cli -- --reveal-email <personId> --domain stripe.com

Options:
  --domains <list>       Account domains, comma separated (max 20)
  --product <value>      A preset (${PRESETS.map((preset) => preset.id).join(', ')})
                         or a free-text description of what you sell. Default: ${DEFAULT_PRESET_ID}
  --fetch                Map people for roles with matches (paid, 2 credits per person)
  --workforce            With --fetch: check department headcounts first (1 credit per account)
  --max-credits <n>      Spend cap for this run (default ${DEFAULT_MAX_CREDITS})
  --dry-run              Free calls only; print what the paid step would cost
  --reveal-email <id>    Find one person's work email (10 credits when newly found)
  --domain <domain>      The person's company domain, for --reveal-email
  --out <dir>            Where to write the report (default: output)
  --help                 Show this help`;

export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      domains: { type: 'string' },
      product: { type: 'string', default: DEFAULT_PRESET_ID },
      fetch: { type: 'boolean', default: false },
      workforce: { type: 'boolean', default: false },
      'max-credits': { type: 'string', default: String(DEFAULT_MAX_CREDITS) },
      'dry-run': { type: 'boolean', default: false },
      'reveal-email': { type: 'string' },
      domain: { type: 'string' },
      out: { type: 'string', default: 'output' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const maxCredits = Number(values['max-credits']);
  if (!Number.isInteger(maxCredits) || maxCredits < 0) throw new UserFacingError('--max-credits must be a whole number of credits.');

  const help = values.help ?? false;
  const revealId = values['reveal-email'];
  if (revealId !== undefined && !values.domain) throw new UserFacingError('--reveal-email needs --domain <company domain>.');
  if (revealId === undefined && !values.domains && !help) throw new UserFacingError('Pass --domains, e.g. --domains stripe.com,posthog.com (or --help).');
  if (values.workforce && !values.fetch) throw new UserFacingError('--workforce runs as part of --fetch; add --fetch.');

  return {
    domains: values.domains ? parseDomainList(values.domains) : [],
    product: values.product!.trim(),
    fetch: values.fetch ?? false,
    workforce: values.workforce ?? false,
    maxCredits,
    dryRun: values['dry-run'] ?? false,
    revealEmail: revealId !== undefined ? { personId: revealId, domain: values.domain! } : null,
    outDir: values.out!,
    help,
  };
}
