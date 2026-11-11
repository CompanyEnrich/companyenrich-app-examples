/**
 * A small RFC 4180 CSV reader and writer. It handles quoted fields, doubled quotes,
 * commas and newlines inside quotes, CRLF line endings and a UTF-8 byte order mark,
 * which covers HubSpot and Salesforce exports.
 */

export interface Table {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCsv(text: string): string[][] {
  const input = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** Parses CSV text into rows keyed by header. Missing trailing cells become empty strings. */
export function readTable(text: string): Table {
  const [headerRow, ...dataRows] = parseCsv(text);
  if (!headerRow) return { headers: [], rows: [] };
  const headers = headerRow.map((header) => header.trim());
  const rows = dataRows.map((cells) =>
    Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])),
  );
  return { headers, rows };
}

export function escapeCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const FORMULA_START = /^'*[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

/**
 * Spreadsheet apps run a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return
 * as a formula, and enriched text comes from outside. Such cells get a leading `'` (the OWASP
 * advice for CSV injection), which `restoreFormula` removes before anything is written to the CRM.
 * Plain numbers such as `-5` are left alone because they cannot be formulas. A value that already
 * starts with `'` before one of those characters gets one more, so the round trip is exact.
 */
export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
}

export function restoreFormula(value: string): string {
  return /^'+[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

/** Writes CSV for people to open in a spreadsheet, with formula-like cells neutralized. */
export function toCsv(headers: string[], rows: Record<string, string>[]): string {
  const lines = [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ''))];
  return lines.map((cells) => cells.map((cell) => escapeCsvField(neutralizeFormula(cell))).join(',')).join('\n') + '\n';
}
