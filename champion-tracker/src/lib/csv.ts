import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { normalizeDomain } from './domains.js';

export interface ChampionRow {
  /** Line number in the file, for messages. */
  line: number;
  /** Set for rows identified by email. A row with both columns uses the cheaper person_id. */
  email?: string;
  personId?: string;
  accountDomain: string;
  dealName: string;
  owner: string;
}

export class CsvError extends Error {}

export function readChampionsCsv(path: string): ChampionRow[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new CsvError(`Could not read ${path}. Pass the path to your champions CSV, for example: npm start -- init champions.csv`);
  }
  return parseChampionsCsv(text, path);
}

export function parseChampionsCsv(text: string, source = 'CSV'): ChampionRow[] {
  let header: string[] = [];
  let records: { record: Record<string, string>; info: { lines: number } }[];
  try {
    records = parse(text, {
      columns: (names: string[]) => (header = names.map((name) => name.trim().toLowerCase())),
      comment: '#',
      comment_no_infix: true,
      skip_empty_lines: true,
      trim: true,
      info: true,
    });
  } catch (error) {
    throw new CsvError(`${source} could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const missing = ['account_domain', 'owner'].filter((column) => !header.includes(column));
  if (!header.includes('email') && !header.includes('person_id')) missing.unshift('email or person_id');
  if (missing.length > 0) throw new CsvError(`${source} is missing the column(s): ${missing.join(', ')}.`);

  const rows: ChampionRow[] = [];
  const problems: string[] = [];
  for (const { record, info } of records) {
    const line = info.lines;
    const email = record.email?.toLowerCase() || undefined;
    const personId = record.person_id || undefined;
    const accountDomain = normalizeDomain(record.account_domain);
    const owner = record.owner ?? '';
    if (!email && !personId) problems.push(`line ${line}: needs an email or a person_id`);
    else if (personId && !/^\d+$/.test(personId)) problems.push(`line ${line}: person_id "${personId}" should be a number`);
    else if (!personId && !email!.includes('@')) problems.push(`line ${line}: "${email}" is not an email address`);
    if (!accountDomain) problems.push(`line ${line}: account_domain is empty`);
    if (!owner) problems.push(`line ${line}: owner is empty`);
    rows.push({ line, ...(personId ? { personId } : { email }), accountDomain, dealName: record.deal_name ?? '', owner });
  }
  if (problems.length > 0) throw new CsvError(`${source} has invalid rows:\n  ${problems.join('\n  ')}`);
  return rows;
}

/** Emails are stored only as a hash: enough to recognise a row on the next init, nothing more. */
export function championKey(row: ChampionRow): string {
  if (row.personId) return `id:${row.personId}`;
  return `email:${createHash('sha256').update(row.email!).digest('hex')}`;
}
