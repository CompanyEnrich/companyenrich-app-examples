import { readFile } from 'node:fs/promises';
import { UserError } from './errors.js';
import { NORMALIZER_NAMES } from './normalizers.js';
import type { FieldMapping, Mapping, Policy, Rules } from './types.js';

/** A problem with an input file (CSV, mapping or rules), reported as one line. */
export class ConfigError extends UserError {
  override name = 'ConfigError';
}

export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read ${path}`);
  }
}

async function readJson(path: string): Promise<unknown> {
  const text = await readText(path);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ConfigError(`${where} must be an array of strings`);
  }
  return value as string[];
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ConfigError(`${where} must be a non-empty string`);
  return value;
}

export function parseMapping(raw: unknown, source = 'mapping'): Mapping {
  if (!isRecord(raw)) throw new ConfigError(`${source} must be a JSON object`);
  if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
    throw new ConfigError(`${source}.fields must be a non-empty array`);
  }

  const fields = raw.fields.map((entry, index): FieldMapping => {
    const where = `${source}.fields[${index}]`;
    if (!isRecord(entry)) throw new ConfigError(`${where} must be an object`);
    const normalizer = entry.normalizer ?? 'text';
    if (!NORMALIZER_NAMES.includes(normalizer as never)) {
      throw new ConfigError(`${where}.normalizer must be one of: ${NORMALIZER_NAMES.join(', ')}`);
    }
    if (entry.writeAs !== undefined && entry.writeAs !== 'label' && entry.writeAs !== 'lower-bound') {
      throw new ConfigError(`${where}.writeAs must be "label" or "lower-bound"`);
    }
    return {
      column: requireString(entry.column, `${where}.column`),
      path: requireString(entry.path, `${where}.path`),
      normalizer: normalizer as FieldMapping['normalizer'],
      ...(entry.hubspotProperty === undefined
        ? {}
        : { hubspotProperty: requireString(entry.hubspotProperty, `${where}.hubspotProperty`) }),
      ...(entry.writeAs === undefined ? {} : { writeAs: entry.writeAs }),
    };
  });

  for (const key of ['column', 'path'] as const) {
    const seen = new Set<string>();
    for (const field of fields) {
      if (seen.has(field[key])) throw new ConfigError(`${source}.fields has the ${key} "${field[key]}" twice`);
      seen.add(field[key]);
    }
  }

  const domainColumns = stringList(raw.domainColumns, `${source}.domainColumns`);
  if (domainColumns.length === 0) throw new ConfigError(`${source}.domainColumns must list at least one column`);

  return {
    recordIdColumn: requireString(raw.recordIdColumn, `${source}.recordIdColumn`),
    nameColumn: requireString(raw.nameColumn, `${source}.nameColumn`),
    domainColumns,
    fields,
  };
}

export function parseRules(raw: unknown, mapping: Mapping, source = 'rules'): Rules {
  if (!isRecord(raw)) throw new ConfigError(`${source} must be a JSON object`);
  const rules: Rules = {
    neverOverwrite: stringList(raw.neverOverwrite, `${source}.neverOverwrite`),
    fillOnlyIfEmpty: stringList(raw.fillOnlyIfEmpty, `${source}.fillOnlyIfEmpty`),
    trustApi: stringList(raw.trustApi, `${source}.trustApi`),
  };

  const columns = new Set(mapping.fields.map((field) => field.column));
  const listed = new Map<string, string>();
  for (const [list, names] of Object.entries(rules)) {
    for (const name of names) {
      if (!columns.has(name)) throw new ConfigError(`${source}.${list} names "${name}", which is not a mapped column`);
      const previous = listed.get(name);
      if (previous) throw new ConfigError(`"${name}" is in both ${source}.${previous} and ${source}.${list}`);
      listed.set(name, list);
    }
  }
  return rules;
}

export function policyFor(column: string, rules: Rules): Policy {
  if (rules.neverOverwrite.includes(column)) return 'neverOverwrite';
  if (rules.fillOnlyIfEmpty.includes(column)) return 'fillOnlyIfEmpty';
  if (rules.trustApi.includes(column)) return 'trustApi';
  return 'unlisted';
}

export async function loadMapping(path: string): Promise<Mapping> {
  return parseMapping(await readJson(path), path);
}

export async function loadRules(path: string, mapping: Mapping): Promise<Rules> {
  return parseRules(await readJson(path), mapping, path);
}
