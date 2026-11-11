import { existsSync, readFileSync } from 'node:fs';
import type { Company } from '@companyenrich/sdk';
import { z } from 'zod';
import { DEPARTMENTS } from './departments.js';
import type { Seniority } from './profile.js';

export type EmployeeRange = NonNullable<Company['employees']>;
export type RevenueRange = NonNullable<Company['revenue']>;
export type Category = NonNullable<Company['categories']>[number];

// Ordered from smallest to largest, so a band next to an accepted one can earn partial points.
export const EMPLOYEE_RANGES = ['1-10', '11-50', '51-200', '201-500', '501-1K', '1K-5K', '5K-10K', 'over-10K'] as const satisfies readonly EmployeeRange[];
export const REVENUE_RANGES = ['under-1m', '1m-10m', '10m-50m', '50m-100m', '100m-200m', '200m-1b', 'over-1b'] as const satisfies readonly RevenueRange[];
const CATEGORIES = ['b2b', 'b2c', 'b2g', 'e-commerce', 'media', 'service-provider', 'mobile', 'saas', 'local-business'] as const satisfies readonly Category[];
const SENIORITIES = ['owner', 'founder', 'c-suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern'] as const satisfies readonly Seniority[];

function criterion<T extends z.ZodType>(value: T) {
  return z.strictObject({
    weight: z.number().min(0),
    match: z.array(value).min(1),
  });
}

const configSchema = z.strictObject({
  icp: z
    .strictObject({
      employees: criterion(z.enum(EMPLOYEE_RANGES)).optional(),
      revenue: criterion(z.enum(REVENUE_RANGES)).optional(),
      categories: criterion(z.enum(CATEGORIES)).optional(),
      country: criterion(z.string().regex(/^[A-Z]{2}$/, 'use two-letter country codes such as "US"')).optional(),
    })
    .refine((icp) => Object.values(icp).some((rule) => rule && rule.weight > 0), 'give at least one criterion a weight above 0'),
  buyerPersona: z.strictObject({
    seniority: z.array(z.enum(SENIORITIES)).min(1),
    department: z
      .array(z.enum(DEPARTMENTS, { error: 'not a department the API accepts; use values such as "sales" or "sales/revenue-operations" (full list in src/lib/departments.ts)' }))
      .default([]),
  }),
});

export type TrackerConfig = z.infer<typeof configSchema>;
export type IcpCriteria = TrackerConfig['icp'];
export type BuyerPersona = TrackerConfig['buyerPersona'];

export class ConfigError extends Error {}

export const DEFAULT_CONFIG_PATH = 'config/icp.json';
export const EXAMPLE_CONFIG_PATH = 'config/icp.example.json';

/** Reads the config, falling back to the shipped example so a first run works before you customise it. */
export function resolveConfigPath(requested: string | undefined): string {
  if (requested) return requested;
  return existsSync(DEFAULT_CONFIG_PATH) ? DEFAULT_CONFIG_PATH : EXAMPLE_CONFIG_PATH;
}

export function loadConfig(path: string): TrackerConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const reason = error instanceof SyntaxError ? `is not valid JSON (${error.message})` : 'could not be read';
    throw new ConfigError(`Config file ${path} ${reason}.`);
  }
  return parseConfig(raw, path);
}

export function parseConfig(raw: unknown, source = 'config'): TrackerConfig {
  const result = configSchema.safeParse(raw);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  throw new ConfigError(`${source} is invalid:\n${problems.join('\n')}`);
}
