import { parseCsv } from './csv.js';

const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Turns whatever a CRM export holds ("https://www.Acme.com/pricing", "jane@acme.com", "acme.com.")
 * into a bare lowercase domain. Returns undefined when the result is not a valid domain.
 */
export function normalizeDomain(raw: string): string | undefined {
  let value = raw.trim().toLowerCase();
  value = value.slice(value.lastIndexOf('@') + 1); // email address -> its domain
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // protocol
  value = value.split(/[/?#]/, 1)[0] ?? ''; // path, query, fragment
  value = value.replace(/:\d+$/, ''); // port
  value = value.replace(/\.$/, ''); // trailing dot
  value = value.replace(/^www\d*\./, '');
  return DOMAIN_PATTERN.test(value) ? value : undefined;
}

export interface InvalidRow {
  /** 1-based row number in the file, header included. */
  row: number;
  value: string;
}

export interface CustomerList {
  /** Unique normalized domains in file order. */
  domains: string[];
  invalid: InvalidRow[];
  duplicates: number;
}

/**
 * Reads customer domains from CSV text. Uses the column named `domain` when the header has one,
 * otherwise the first column. A first row whose value is not a domain is treated as a header.
 */
export function readCustomerDomains(csvText: string): CustomerList {
  const rows = parseCsv(csvText);
  const header = rows[0]?.map((cell) => cell.trim().toLowerCase()) ?? [];
  const domainColumn = header.indexOf('domain');
  const column = domainColumn >= 0 ? domainColumn : 0;
  const hasHeader = domainColumn >= 0 || (rows[0] !== undefined && normalizeDomain(rows[0][0] ?? '') === undefined);

  const seen = new Set<string>();
  const result: CustomerList = { domains: [], invalid: [], duplicates: 0 };

  rows.forEach((row, index) => {
    if (index === 0 && hasHeader) return;
    const value = (row[column] ?? '').trim();
    if (value === '') return;
    const domain = normalizeDomain(value);
    if (!domain) {
      result.invalid.push({ row: index + 1, value });
    } else if (seen.has(domain)) {
      result.duplicates++;
    } else {
      seen.add(domain);
      result.domains.push(domain);
    }
  });
  return result;
}
