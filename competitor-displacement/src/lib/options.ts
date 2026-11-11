import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { UsageError } from './errors.js';
import { readExcludeFile } from './exclude.js';
import { CATEGORIES, EMPLOYEE_RANGES } from './filters.js';
import { isPersonaName, PERSONA_NAMES } from './personas.js';
import type { PipelineOptions } from './pipeline.js';
import type { Category, EmployeeRange } from './types.js';

export const USAGE = `Usage: npm start -- --competitor <tech> [options]

  --competitor <tech>     technology your prospects run today (required, e.g. zendesk)
  --mine <tech>           your technology; companies already running it are excluded
  --country <codes>       comma-separated ISO country codes, e.g. US,GB
  --employees <ranges>    comma-separated: ${EMPLOYEE_RANGES.join(', ')}
  --categories <names>    comma-separated, any of: ${CATEGORIES.join(', ')}
  --accounts <n>          accounts to fetch, 1 credit each (default 10, max 100)
  --contacts <n>          contacts per account, 2 credits each (default 1, max 10, 0 to skip)
  --persona <name>        override the buyer: ${PERSONA_NAMES.join(', ')}
  --with-funding          add the latest funding round to each account (+1 credit per account)
  --max-credits <n>       stop before any paid step that would take the run past this (default 40)
  --exclude <file>        skip domains already bought: a list, or a previous run's accounts.csv
  --dry-run               free steps only: market size, tiers and a cost estimate
  --out <dir>             output folder (default output)
  -h, --help              show this help`;

const FLAGS = {
  competitor: { type: 'string' },
  mine: { type: 'string' },
  country: { type: 'string' },
  employees: { type: 'string' },
  categories: { type: 'string' },
  accounts: { type: 'string', default: '10' },
  contacts: { type: 'string', default: '1' },
  persona: { type: 'string' },
  'with-funding': { type: 'boolean', default: false },
  'max-credits': { type: 'string', default: '40' },
  exclude: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  out: { type: 'string', default: 'output' },
  help: { type: 'boolean', short: 'h', default: false },
} as const satisfies ParseArgsOptionsConfig;

function integer(value: string, flag: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`${flag} must be a whole number from ${min} to ${max}, got "${value}".`);
  }
  return parsed;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Maps each value to its allowed spelling, ignoring case ("1k-5k" -> "1K-5K"). */
function oneOf<T extends string>(values: string[], allowed: readonly T[], flag: string): T[] {
  const lookup = new Map(allowed.map((value) => [value.toLowerCase(), value]));
  const unknown = values.filter((value) => !lookup.has(value.toLowerCase()));
  if (unknown.length > 0) throw new UsageError(`${flag} does not accept ${unknown.join(', ')}. Use any of: ${allowed.join(', ')}.`);
  return values.map((value) => lookup.get(value.toLowerCase()) as T);
}

function countries(value: string | undefined): string[] {
  const codes = list(value).map((code) => code.toUpperCase());
  const invalid = codes.filter((code) => !/^[A-Z]{2}$/.test(code));
  if (invalid.length > 0) throw new UsageError(`--country takes two-letter ISO codes such as US or GB, got ${invalid.join(', ')}.`);
  return codes;
}

/** Parses CLI arguments into pipeline options. Returns undefined for --help. */
export function parseCliArgs(argv: string[]): PipelineOptions | undefined {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: FLAGS, allowPositionals: false });
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${USAGE}`); // unknown flag, missing value or stray argument
  }
  const { values } = parsed;
  if (values.help) return undefined;
  if (!values.competitor?.trim()) throw new UsageError(`--competitor is required.\n\n${USAGE}`);
  if (values.persona !== undefined && !isPersonaName(values.persona)) {
    throw new UsageError(`--persona must be one of ${PERSONA_NAMES.join(', ')}, got "${values.persona}".`);
  }

  return {
    competitor: values.competitor,
    mine: values.mine?.trim() || undefined,
    countries: countries(values.country),
    employees: oneOf<EmployeeRange>(list(values.employees), EMPLOYEE_RANGES, '--employees'),
    categories: oneOf<Category>(list(values.categories), CATEGORIES, '--categories'),
    accounts: integer(values.accounts, '--accounts', 1, 100),
    contacts: integer(values.contacts, '--contacts', 0, 10),
    persona: values.persona,
    withFunding: values['with-funding'],
    maxCredits: integer(values['max-credits'], '--max-credits', 0, 100_000),
    dryRun: values['dry-run'],
    exclude: values.exclude === undefined ? [] : readExcludeFile(values.exclude),
    outDir: values.out,
  };
}
