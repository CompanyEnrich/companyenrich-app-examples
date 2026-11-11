import type { CompanyRow, PersonRow } from './rows.js';

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | undefined;
}

/** Characters that make spreadsheet apps treat a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell, RFC 4180 style. Text that starts like a formula is prefixed with a
 * quote mark so a company description cannot run as a formula when opened in Excel.
 */
export function csvCell(value: string | number | undefined): string {
  if (value === undefined) return '';
  let cell = String(value);
  if (typeof value === 'string' && FORMULA_START.test(cell)) cell = `'${cell}`;
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((column) => csvCell(column.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(column.value(row))).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export const COMPANY_COLUMNS: CsvColumn<CompanyRow>[] = [
  { header: 'name', value: (row) => row.name },
  { header: 'domain', value: (row) => row.domain },
  { header: 'industry', value: (row) => row.industry },
  { header: 'employees', value: (row) => row.employees },
  { header: 'revenue', value: (row) => row.revenue },
  { header: 'founded_year', value: (row) => row.foundedYear },
  { header: 'city', value: (row) => row.city },
  { header: 'country', value: (row) => row.country },
  { header: 'funding_stage', value: (row) => row.fundingStage },
  { header: 'total_funding_usd', value: (row) => row.totalFunding },
  { header: 'similarity_score', value: (row) => row.score },
  { header: 'linkedin_url', value: (row) => row.linkedinUrl },
  { header: 'description', value: (row) => row.description },
];

export const PERSON_COLUMNS: CsvColumn<PersonRow>[] = [
  { header: 'name', value: (row) => row.name },
  { header: 'position', value: (row) => row.position },
  { header: 'seniority', value: (row) => row.seniority },
  { header: 'department', value: (row) => row.department },
  { header: 'company', value: (row) => row.company },
  { header: 'company_domain', value: (row) => row.companyDomain },
  { header: 'country', value: (row) => row.country },
  { header: 'linkedin_url', value: (row) => row.linkedinUrl },
];
