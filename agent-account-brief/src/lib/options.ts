import { parseArgs } from 'node:util';
import { parseTarget, type Target } from './input';
import type { Depth } from './pipeline';

export type Mode = 'agent' | 'pipeline';

export interface Options {
  target: Target;
  mode: Mode;
  depth: Depth;
  maxCredits: number;
  dryRun: boolean;
  outDir: string;
  /** Set when the mode was chosen for the user, e.g. no Anthropic key, so the CLI can say so. */
  notice?: string;
}

export const USAGE = `Usage: npm start -- <domain | email> [options]

  npm start -- stripe.com
  npm start -- someone@company.com --depth full

Options:
  --mode agent|pipeline   agent uses Claude (needs ANTHROPIC_API_KEY); pipeline is rule-based.
                          Default: agent when ANTHROPIC_API_KEY is set, else pipeline.
  --depth quick|full      quick: company + funding + 3 executives (up to 8 credits).
                          full: adds tech, workforce, 6 department leaders, 3 lookalikes (up to 37).
                          Default: quick.
  --max-credits <n>       Hard cap on credits for this run. Default: 40.
  --dry-run               Use only free endpoints and print what the run would spend.
  --out <dir>             Where to write the brief. Default: output
  -h, --help              Show this help.`;

export class UsageError extends Error {
  override name = 'UsageError';
}

/** Returns undefined when the user asked for help. */
export function parseOptions(argv: string[], env: Record<string, string | undefined>): Options | undefined {
  const { values, positionals } = parseCli(argv);
  if (values.help) return undefined;

  if (positionals.length !== 1) throw new UsageError('Give exactly one domain or email, for example: npm start -- stripe.com');
  const target = parseTarget(positionals[0]!);

  const depth = values.depth;
  if (depth !== 'quick' && depth !== 'full') throw new UsageError('--depth must be quick or full.');

  const maxCredits = Number(values['max-credits']);
  if (!Number.isInteger(maxCredits) || maxCredits < 0) throw new UsageError('--max-credits must be a whole number, 0 or more.');

  const hasAnthropicKey = Boolean(env.ANTHROPIC_API_KEY);
  let notice: string | undefined;
  let mode: Mode;
  if (values.mode === undefined) {
    mode = hasAnthropicKey ? 'agent' : 'pipeline';
    if (!hasAnthropicKey) notice = 'ANTHROPIC_API_KEY is not set, so this runs in pipeline mode (rule-based, no LLM).';
  } else if (values.mode === 'agent' || values.mode === 'pipeline') {
    mode = values.mode;
  } else {
    throw new UsageError('--mode must be agent or pipeline.');
  }
  if (mode === 'agent' && !hasAnthropicKey) {
    throw new UsageError('Agent mode needs ANTHROPIC_API_KEY. Set it, or use --mode pipeline to run without an LLM.');
  }

  return { target, mode, depth, maxCredits, dryRun: values['dry-run'], outDir: values.out, notice };
}

function parseCli(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        mode: { type: 'string' },
        depth: { type: 'string', default: 'quick' },
        'max-credits': { type: 'string', default: '40' },
        'dry-run': { type: 'boolean', default: false },
        out: { type: 'string', default: 'output' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    // parseArgs throws a TypeError for unknown or malformed flags.
    if (error instanceof TypeError) {
      const firstLine = (error.message.split('\n')[0] ?? '').replace(/\.$/, '');
      throw new UsageError(`${firstLine}. Run with --help for usage.`);
    }
    throw error;
  }
}
