import type { Category } from './categorize.ts';

const HEADER = ['category', 'name', 'domain', 'website', 'description', 'industry', 'employees', 'founded_year', 'country', 'keywords', 'logo_url'];

/** One row per company, grouped by category in map order. */
export function companiesCsv(categories: Category[]): string {
  const rows = categories.flatMap((category) =>
    category.companies.map((company) => [
      category.name,
      company.name ?? '',
      company.domain,
      company.website,
      company.description ?? '',
      company.industry ?? '',
      company.employees ?? '',
      company.foundedYear?.toString() ?? '',
      company.location?.country?.name ?? '',
      (company.keywords ?? []).join('; '),
      company.logoUrl,
    ]),
  );
  return [HEADER, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/**
 * Quotes a value per RFC 4180. Values starting with = + - @ get a leading apostrophe so a spreadsheet
 * does not run third-party text as a formula.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
