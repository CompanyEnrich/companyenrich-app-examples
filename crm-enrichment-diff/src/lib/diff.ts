import type { Company } from '@companyenrich/sdk';
import { normalizers, type Normalizer } from './normalizers.js';
import type { ChangeType, CrmRecord, DiffCell, FieldMapping } from './types.js';

/** A diffed cell before the rules have decided what to do with it. */
export type CellDiff = Omit<DiffCell, 'action' | 'reason'>;

/** Reads a dot path such as `location.country.name` from a company, as text. Arrays are joined. */
export function readPath(company: Company, path: string): string {
  let value: unknown = company;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object') return '';
    value = (value as Record<string, unknown>)[key];
  }
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

export function classify(crm: string, api: string, normalizer: Normalizer): { change: ChangeType; note?: string } {
  if (!api) return { change: 'api-missing' };
  if (normalizer.isEmpty(crm)) return { change: 'fill' };
  const { same, note } = normalizer.compare(crm.trim(), api);
  return { change: same ? 'same' : 'conflict', ...(note ? { note } : {}) };
}

function diffField(record: CrmRecord, company: Company, field: FieldMapping): CellDiff {
  const normalizer = normalizers[field.normalizer];
  const crmValue = record.row[field.column] ?? '';
  const apiValue = readPath(company, field.path);
  const { change, note } = classify(crmValue, apiValue, normalizer);
  const isChange = change === 'fill' || change === 'conflict';
  const newValue = isChange ? normalizer.toCrm(apiValue, field.writeAs ?? 'label') : null;

  return {
    recordId: record.recordId,
    company: record.name || company.name || company.domain,
    domain: record.domain ?? company.domain,
    column: field.column,
    field: field.path,
    change,
    crmValue,
    apiValue,
    newValue: newValue ?? '',
    ...(note ? { note } : {}),
  };
}

/** Compares every mapped field of one CRM record with its enriched company. */
export function diffRecord(record: CrmRecord, company: Company, fields: FieldMapping[]): CellDiff[] {
  return fields.map((field) => diffField(record, company, field));
}
