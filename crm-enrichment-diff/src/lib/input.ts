import { ConfigError } from './config.js';
import { readTable } from './csv.js';
import { normalizeDomain } from './domains.js';
import type { CrmRecord, Mapping } from './types.js';

export interface CrmExport {
  records: CrmRecord[];
  /** Each domain once, in first-seen order. These are the only domains we pay to enrich. */
  domains: string[];
  /** Domains shared by more than one record, with the record IDs that share them. */
  duplicates: Map<string, string[]>;
}

/** Reads a CRM export, normalizes each row's domain and deduplicates the domains. */
export function readCrmExport(csvText: string, mapping: Mapping): CrmExport {
  const { headers, rows } = readTable(csvText);
  const required = [mapping.recordIdColumn, mapping.nameColumn, ...mapping.fields.map((field) => field.column)];
  const missing = required.filter((column) => !headers.includes(column));
  if (!mapping.domainColumns.some((column) => headers.includes(column))) {
    missing.push(mapping.domainColumns.join(' or '));
  }
  if (missing.length > 0) {
    throw new ConfigError(`The CSV has no column named ${missing.map((column) => `"${column}"`).join(', ')}. Check the mapping file.`);
  }

  const seenIds = new Set<string>();
  const records = rows.map((row, index): CrmRecord => {
    const recordId = (row[mapping.recordIdColumn] ?? '').trim();
    if (!recordId) throw new ConfigError(`Row ${index + 2} has an empty "${mapping.recordIdColumn}"`);
    if (seenIds.has(recordId)) throw new ConfigError(`Record ID ${recordId} appears twice in the CSV`);
    seenIds.add(recordId);

    const candidates = mapping.domainColumns.map((column) => (row[column] ?? '').trim()).filter(Boolean);
    const domain = candidates.map(normalizeDomain).find((value) => value !== null) ?? null;
    return {
      recordId,
      name: (row[mapping.nameColumn] ?? '').trim(),
      domain,
      rawDomain: candidates[0] ?? '',
      row,
    };
  });

  const byDomain = new Map<string, string[]>();
  for (const record of records) {
    if (!record.domain) continue;
    byDomain.set(record.domain, [...(byDomain.get(record.domain) ?? []), record.recordId]);
  }
  const duplicates = new Map([...byDomain].filter(([, ids]) => ids.length > 1));

  return { records, domains: [...byDomain.keys()], duplicates };
}
