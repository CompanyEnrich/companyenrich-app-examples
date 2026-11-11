import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { UsageError } from './errors.js';
import type { TalentMapOptions } from './talent-map.js';
import { EMPLOYEE_RANGES, SENIORITIES, type EmployeeRange, type Seniority } from './types.js';

export const USAGE = `Usage: npm start -- --role "<title>" [options]

  --role <titles>            job title phrase(s), comma-separated, e.g. "data engineer"
  --seniority <levels>       comma-separated: ${SENIORITIES.join(', ')}
  --company <text>           plain-English description of the companies to source from
  --technologies <names>     comma-separated; every one must be in the company's stack
  --employees <ranges>       comma-separated: ${EMPLOYEE_RANGES.join(', ')}
  --country <code>           company headquarters country, e.g. US
  --min-tenure-years <n>     only people at their company at least this long (e.g. 2 or 1.5)
  --people <n>               profiles to shortlist, 2 credits each (default 20, max 100)
  --trend-top <n>            top companies to fetch team trends for, 1 credit each (default 3, max 10)
  --max-credits <n>          stop before any paid step that would take the run past this (default 50)
  --dry-run                  free sizing only: no paid calls, prints the estimate
  --out <dir>                output folder (default output)
  -h, --help                 show this help`;

const FLAGS = {
  role: { type: 'string' },
  seniority: { type: 'string' },
  company: { type: 'string' },
  technologies: { type: 'string' },
  employees: { type: 'string' },
  country: { type: 'string' },
  'min-tenure-years': { type: 'string' },
  people: { type: 'string', default: '20' },
  'trend-top': { type: 'string', default: '3' },
  'max-credits': { type: 'string', default: '50' },
  'dry-run': { type: 'boolean', default: false },
  out: { type: 'string', default: 'output' },
  help: { type: 'boolean', short: 'h', default: false },
} as const satisfies ParseArgsOptionsConfig;

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function integer(value: string, flag: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`${flag} must be a whole number from ${min} to ${max}, got "${value}".`);
  }
  return parsed;
}

function oneOf<T extends string>(values: string[], allowed: readonly T[], flag: string): T[] {
  for (const value of values) {
    if (!allowed.includes(value as T)) throw new UsageError(`${flag} accepts ${allowed.join(', ')}; got "${value}".`);
  }
  return values as T[];
}

export type CliOptions = TalentMapOptions & { outDir: string };

/** Parses and validates the flags; returns undefined for --help. */
export function parseOptions(argv: string[]): CliOptions | undefined {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: FLAGS });
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${USAGE}`); // unknown flag or missing value
  }
  const { values } = parsed;
  if (values.help) return undefined;

  const roles = list(values.role);
  if (roles.length === 0) throw new UsageError(`--role is required.\n\n${USAGE}`);
  const country = values.country?.trim().toUpperCase();
  if (country !== undefined && !/^[A-Z]{2}$/.test(country)) throw new UsageError(`--country must be a two-letter code such as US, got "${values.country}".`);
  const tenure = values['min-tenure-years'] === undefined ? undefined : Number(values['min-tenure-years']);
  if (tenure !== undefined && !(tenure > 0 && tenure <= 40)) {
    throw new UsageError(`--min-tenure-years must be a number above 0 and at most 40, got "${values['min-tenure-years']}".`);
  }
  const description = values.company?.trim();

  return {
    roles,
    seniority: oneOf<Seniority>(list(values.seniority), SENIORITIES, '--seniority'),
    environment: {
      ...(description ? { description } : {}),
      technologies: list(values.technologies),
      employees: oneOf<EmployeeRange>(list(values.employees), EMPLOYEE_RANGES, '--employees'),
      ...(country ? { country } : {}),
    },
    ...(tenure !== undefined ? { minTenureYears: tenure } : {}),
    people: integer(values.people, '--people', 1, 100),
    trendTop: integer(values['trend-top'], '--trend-top', 0, 10),
    maxCredits: integer(values['max-credits'], '--max-credits', 0, 100_000),
    dryRun: values['dry-run'],
    outDir: values.out,
  };
}
