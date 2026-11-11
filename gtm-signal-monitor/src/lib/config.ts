import { readFileSync } from 'node:fs';
import type { components } from '@companyenrich/sdk';
import { parse, YAMLParseError } from 'yaml';
import { z } from 'zod';
import { checkCompanyFilter } from './company-filter.js';
import { normalizeDomain } from './domains.js';

type Schemas = components['schemas'];
export type CompanySearchFilter = NonNullable<Schemas['CompanySearchFilter']>;
export type PersonSearchFilter = NonNullable<Schemas['PersonSearchFilter']>;
type PersonSeniority = NonNullable<Schemas['NullableOfPersonSeniority']>;

const SENIORITIES = [
  'owner', 'founder', 'c-suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern',
] as const satisfies readonly PersonSeniority[];

export const COMPANY_EXPANSIONS = ['financial', 'keywords', 'naicsCodes', 'technologies', 'workforce'] as const;
/** The expansions account-changes knows how to diff. */
export const ACCOUNT_EXPANSIONS = ['financial', 'technologies', 'workforce'] as const;

/** Search endpoints return at most 100 results per page. */
const MAX_PAGE_SIZE = 100;

const watcherId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and dashes, for example "funded-saas"');

const domain = z
  .string()
  .transform(normalizeDomain)
  .pipe(z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Expected a domain such as "stripe.com"'));

const domainList = (max: number) =>
  z
    .array(domain)
    .min(1, 'List at least one domain')
    .max(max, `List at most ${max} domains`)
    .transform((list) => [...new Set(list)]);

const maxResultsPerRun = z.number().int().min(1).max(MAX_PAGE_SIZE).default(10);

const newCompaniesSchema = z.strictObject({
  id: watcherId,
  type: z.literal('new-companies'),
  title: z.string().min(1).optional(),
  maxResultsPerRun,
  expand: z.array(z.enum(COMPANY_EXPANSIONS)).default([]),
  query: z
    .strictObject({
      // Passed to the API as is, after a local key check that catches typos.
      filter: z
        .record(z.string(), z.unknown())
        .superRefine((filter, ctx) => {
          for (const issue of checkCompanyFilter(filter)) ctx.addIssue({ code: 'custom', ...issue });
        })
        .optional(),
      semantic: z
        .strictObject({
          query: z.string().min(1),
          autoFilter: z.boolean().optional(),
          weight: z.number().min(0).max(1).optional(),
        })
        .optional(),
    })
    .refine((query) => query.filter || query.semantic, 'Set query.filter, query.semantic, or both'),
});

const newLeadersSchema = z.strictObject({
  id: watcherId,
  type: z.literal('new-leaders'),
  title: z.string().min(1).optional(),
  domains: domainList(2500),
  seniority: z.array(z.enum(SENIORITIES)).min(1).optional(),
  department: z
    .array(
      z
        .string()
        .regex(/^[a-z-]+(\/[a-z-]+)?$/, 'Expected a department such as "sales" or "engineering-technical/data-science"'),
    )
    .min(1)
    .optional(),
  lookbackDays: z.number().int().min(1).max(365).default(30),
  maxResultsPerRun,
});

const accountChangesSchema = z.strictObject({
  id: watcherId,
  type: z.literal('account-changes'),
  title: z.string().min(1).optional(),
  domains: domainList(500),
  expand: z.array(z.enum(ACCOUNT_EXPANSIONS)).default([...ACCOUNT_EXPANSIONS]),
  refreshEveryDays: z.number().min(0).default(7),
  headcountChangePct: z.number().min(0).default(10),
});

const configSchema = z
  .strictObject({
    watchers: z
      .array(z.discriminatedUnion('type', [newCompaniesSchema, newLeadersSchema, accountChangesSchema]))
      .min(1, 'Add at least one watcher'),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.watchers.forEach((watcher, index) => {
      if (seen.has(watcher.id)) {
        ctx.addIssue({ code: 'custom', path: ['watchers', index, 'id'], message: `Duplicate watcher id "${watcher.id}"` });
      }
      seen.add(watcher.id);
    });
  });

export type MonitorConfig = z.infer<typeof configSchema>;
export type WatcherConfig = MonitorConfig['watchers'][number];
export type NewCompaniesConfig = Extract<WatcherConfig, { type: 'new-companies' }>;
export type NewLeadersConfig = Extract<WatcherConfig, { type: 'new-leaders' }>;
export type AccountChangesConfig = Extract<WatcherConfig, { type: 'account-changes' }>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(path: string): MonitorConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(
        `Config file not found: ${path}. Copy monitor.config.example.yaml to monitor.config.yaml to get started.`,
      );
    }
    throw error;
  }
  return parseConfig(text, path);
}

export function parseConfig(text: string, source = 'config'): MonitorConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const firstLine = error.message.split('\n')[0]?.replace(/:$/, '');
      throw new ConfigError(`${source} is not valid YAML: ${firstLine}`);
    }
    throw error;
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  - ${formatPath(issue.path)}: ${issue.message}`);
    throw new ConfigError(`${source} is invalid:\n${lines.join('\n')}`);
  }
  return result.data;
}

/** ["watchers", 1, "domains"] -> "watchers[1].domains" */
function formatPath(path: PropertyKey[]): string {
  const text = path.reduce<string>((out, key) => {
    if (typeof key === 'number') return `${out}[${key}]`;
    return out ? `${out}.${String(key)}` : String(key);
  }, '');
  return text || '(top level)';
}
