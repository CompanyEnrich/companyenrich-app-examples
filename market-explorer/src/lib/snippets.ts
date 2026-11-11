/** Copy-paste exports of the current filter: JSON, SDK code, and curl. */
import type { CompanyFilter } from './options';

export const API_BASE_URL = 'https://api.companyenrich.com';

export function filterJson(filter: CompanyFilter): string {
  return JSON.stringify(filter, null, 2);
}

/**
 * A runnable TypeScript example. The filter is annotated with the SDK's own type:
 * without it, TypeScript widens enum values like "51-200" to `string` and the
 * calls below stop compiling.
 */
export function sdkSnippet(filter: CompanyFilter, pageSize = 25): string {
  return `import { CompanyEnrich, type components } from '@companyenrich/sdk';

type CompanySearchFilter = components['schemas']['CompanySearchFilter'];

// Reads COMPANYENRICH_API_KEY from the environment.
const client = new CompanyEnrich();

const filter: CompanySearchFilter = ${filterJson(filter)};

// Free: how many companies match.
const { count, total } = await client.companies.count({ filter });

// Paid: 1 credit per returned company.
const page = await client.companies.search({ filter, pageSize: ${pageSize} });
console.log(count, total, page.items.map((company) => company.domain));
`;
}

/** Quotes a string for a POSIX shell single-quoted argument. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

export function curlSnippet(filter: CompanyFilter): string {
  return `curl -X POST ${API_BASE_URL}/v2/companies/search/count \\
  -H "Authorization: Bearer $COMPANYENRICH_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d ${shellQuote(JSON.stringify({ filter }))}`;
}
