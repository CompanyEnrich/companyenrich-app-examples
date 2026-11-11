import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { CompanySearchParams } from '@companyenrich/sdk';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { UsageError } from './errors.ts';

/** The most category hints a theme can list; the map's palette has eight colors. */
export const MAX_CATEGORY_HINTS = 8;

const CategoryHintSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    keywords: z.array(z.string().trim().min(1)).min(1, 'list at least one keyword'),
  })
  .strict();

type CompanyFilter = NonNullable<CompanySearchParams['filter']>;

/**
 * Every v2 company search filter field. Typed as a Record over the SDK's filter keys, so the compiler
 * fails if a field is missing here or does not exist. A typo such as `industry: Software` fails here,
 * before anything is spent.
 */
const FILTER_FIELDS: Record<keyof CompanyFilter, true> = {
  query: true, id: true, domain: true, keywords: true, technologies: true, region: true, country: true, state: true, city: true,
  type: true, employees: true, reportedEmployees: true, revenue: true, workforceGrowth: true, workforceSize: true, naicsCodes: true,
  categories: true, foundedYear: true, fundingRounds: true, fundingAmount: true, fundingYear: true, require: true,
};

/** Likely mistakes and the field to use instead. */
const FILTER_HINTS: Record<string, string> = {
  industry: 'naicsCodes (NAICS codes listed by the free industries.list() endpoint) or categories',
  industries: 'naicsCodes (NAICS codes listed by the free industries.list() endpoint) or categories',
  countries: 'country',
  location: 'country, state or city',
  size: 'employees',
  headcount: 'employees',
  founded: 'foundedYear',
  funding: 'fundingRounds, fundingAmount or fundingYear',
  name: 'query',
};

function unknownFilterFieldMessage(key: string): string {
  const lower = key.toLowerCase();
  const sameField = Object.keys(FILTER_FIELDS).find(
    (field) => [lower, `${lower}s`, lower.replace(/s$/, '')].includes(field.toLowerCase()),
  );
  const suggestion = FILTER_HINTS[lower] ?? sameField;
  return `not a v2 company search filter field${suggestion ? `; use ${suggestion}` : ''} (fields: https://docs.companyenrich.com)`;
}

const FilterSchema = z.record(z.string(), z.unknown()).superRefine((filter, context) => {
  for (const key of Object.keys(filter)) {
    if (!Object.hasOwn(FILTER_FIELDS, key)) context.addIssue({ code: 'custom', path: [key], message: unknownFilterFieldMessage(key) });
  }
});

const ThemeFileSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    semantic: z.string().trim().min(3).max(500),
    // Field names are checked here; values are checked by the API on the free count call.
    filter: FilterSchema.optional(),
    companies: z.number().int().min(1).max(100).default(20),
    categories: z
      .array(CategoryHintSchema)
      .max(MAX_CATEGORY_HINTS)
      .default([])
      .refine((hints) => new Set(hints.map((hint) => hint.name.toLowerCase())).size === hints.length, 'category names must be unique'),
  })
  .strict();

export type CategoryHint = z.infer<typeof CategoryHintSchema>;

export interface Theme extends Omit<z.infer<typeof ThemeFileSchema>, 'filter'> {
  /** File name without extension, used for the output folder. */
  slug: string;
  filter?: CompanySearchParams['filter'];
}

/** Parses and validates a theme. Throws a UsageError that names every invalid field. */
export function parseTheme(yamlText: string, slug: string): Theme {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new UsageError(`Theme "${slug}" is not valid YAML: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
  const result = ThemeFileSchema.safeParse(raw ?? {});
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new UsageError(`Theme "${slug}" is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  const { filter, ...rest } = result.data;
  return { ...rest, slug, ...(filter ? { filter: filter as Theme['filter'] } : {}) };
}

export async function loadTheme(path: string): Promise<Theme> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new UsageError(`Cannot read theme file ${path}`);
  }
  return parseTheme(text, themeSlug(path));
}

/** "themes/AI Agents.yaml" -> "ai-agents" */
export function themeSlug(path: string): string {
  const slug = basename(path)
    .replace(/\.ya?ml$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'theme';
}
