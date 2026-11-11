import { readFileSync } from 'node:fs';
import { UsageError } from './errors.js';

/** "https://www.Example.com/pricing" -> "example.com". */
export function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
}

/** Splits one CSV line, honouring double quotes ("a, b" stays one field; "" is a literal quote). */
function csvFields(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted && char === '"' && line[i + 1] === '"') {
      field += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  return [...fields, field];
}

/**
 * Reads domains to exclude: either one domain per line (blank lines and # comments are skipped),
 * or a CSV with a `domain` column, such as the accounts.csv of a previous run.
 */
export function parseDomainList(text: string, source: string): string[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
  const header = csvFields(lines[0] ?? '').map((field) => field.trim().toLowerCase());
  const column = header.indexOf('domain');
  const values = column >= 0 ? lines.slice(1).map((line) => csvFields(line)[column] ?? '') : lines;

  const domains = new Set<string>();
  values.forEach((value, index) => {
    const domain = normalizeDomain(value);
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      const line = index + 1 + (column >= 0 ? 1 : 0);
      throw new UsageError(`${source} line ${line}: "${value.trim()}" is not a domain.`);
    }
    domains.add(domain);
  });
  return [...domains];
}

export function readExcludeFile(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new UsageError(`Cannot read --exclude file "${path}": ${(error as Error).message}`);
  }
  const domains = parseDomainList(text, path);
  if (domains.length === 0) throw new UsageError(`--exclude file "${path}" has no domains.`);
  return domains;
}
