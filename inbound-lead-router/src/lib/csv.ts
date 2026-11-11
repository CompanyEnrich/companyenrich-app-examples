// Minimal RFC 4180 CSV: quoted fields, escaped quotes, commas and newlines inside quotes.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^﻿/, '');

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
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
  return rows.filter((r) => r.some((value) => value.trim() !== ''));
}

/** Rows as objects keyed by the header row. */
export function parseCsvRecords(text: string): { header: string[]; records: Record<string, string>[] } {
  const [header = [], ...rows] = parseCsv(text);
  const records = rows.map((row) => Object.fromEntries(header.map((name, index) => [name, row[index] ?? ''])));
  return { header, records };
}

type Cell = string | number | null | undefined;

export function toCsv(rows: Cell[][]): string {
  return `${rows.map((row) => row.map(formatCell).join(',')).join('\n')}\n`;
}

function formatCell(cell: Cell): string {
  let value = cell === null || cell === undefined ? '' : String(cell);
  // Spreadsheet apps run cells that start with these characters as formulas.
  if (/^[=+\-@\t\r]/.test(value) && Number.isNaN(Number(value))) value = `'${value}`;
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
