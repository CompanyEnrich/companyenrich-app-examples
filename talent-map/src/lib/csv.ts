type Cell = string | number | undefined;

/**
 * Profile fields are third-party text. A cell starting with = + - @ (or a tab or carriage return)
 * would run as a formula in Excel or Sheets, so it gets a leading apostrophe.
 */
function neutralizeFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function escapeCell(value: Cell): string {
  if (value === undefined) return '';
  const text = typeof value === 'number' ? String(value) : neutralizeFormula(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180 CSV: quoted fields where needed, doubled quotes, one header row. */
export function toCsv(header: readonly string[], rows: readonly (readonly Cell[])[]): string {
  return [header, ...rows].map((row) => row.map(escapeCell).join(',')).join('\n') + '\n';
}
