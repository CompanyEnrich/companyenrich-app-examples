import { ConfigError } from './config.js';
import { readTable, restoreFormula, toCsv } from './csv.js';
import type { DiffCell } from './types.js';

/**
 * One row per cell to write. `review.html` exports approved changes with exactly these columns,
 * so `apply` reads patch.csv and an exported approved patch the same way.
 */
export const PATCH_COLUMNS = [
  'record_id',
  'company',
  'domain',
  'column',
  'field',
  'change',
  'action',
  'crm_value',
  'api_value',
  'new_value',
] as const;

export type PatchRow = Record<(typeof PATCH_COLUMNS)[number], string>;

export function toPatchRow(cell: DiffCell): PatchRow {
  return {
    record_id: cell.recordId,
    company: cell.company,
    domain: cell.domain,
    column: cell.column,
    field: cell.field,
    change: cell.change,
    action: cell.action,
    crm_value: cell.crmValue,
    api_value: cell.apiValue,
    new_value: cell.newValue,
  };
}

/** patch.csv holds every update the rules propose. Cells marked `review` need a human first. */
export function renderPatchCsv(cells: DiffCell[]): string {
  const rows = cells.filter((cell) => cell.action === 'update').map(toPatchRow);
  return toCsv([...PATCH_COLUMNS], rows);
}

export function parsePatchCsv(text: string, source = 'patch'): PatchRow[] {
  const { headers, rows } = readTable(text);
  const missing = ['record_id', 'field', 'new_value'].filter((column) => !headers.includes(column));
  if (missing.length > 0) {
    throw new ConfigError(`${source} is missing the column(s) ${missing.join(', ')}. Use patch.csv or a patch exported from review.html.`);
  }
  // Undo the spreadsheet protection so the CRM receives the raw value.
  return rows.map(
    (row) => Object.fromEntries(PATCH_COLUMNS.map((column) => [column, restoreFormula(row[column] ?? '')])) as PatchRow,
  );
}
