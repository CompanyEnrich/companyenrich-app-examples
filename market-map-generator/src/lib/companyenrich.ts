import {
  ApiError,
  AuthenticationError,
  BadRequestError,
  CompanyEnrich,
  CompanyEnrichError,
  ConnectionError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  TimeoutError,
  ValidationError,
  type Company,
  type CompanySearchCount,
  type CompanySearchQuery,
} from '@companyenrich/sdk';
import type { Theme } from './theme.ts';

/** The API can be slow on semantic queries, so allow 30 seconds per attempt. */
export function createClient(options: { apiKey?: string; fetch?: typeof globalThis.fetch; maxRetries?: number } = {}): CompanyEnrich {
  return new CompanyEnrich({ timeoutMs: 30_000, ...options });
}

/** The same query drives the free count, the free preview and the paid search. */
export function themeQuery(theme: Theme): CompanySearchQuery {
  return { semantic: { query: theme.semantic }, ...(theme.filter ? { filter: theme.filter } : {}) };
}

/** Free. For a semantic query, `count` is the size of the candidate pool the ranking draws from. */
export function countCompanies(client: CompanyEnrich, theme: Theme): Promise<CompanySearchCount> {
  return client.companies.count(themeQuery(theme));
}

/** Free top-25 names, or null when the plan has no previews. Used by --dry-run only, never relied on. */
export async function previewNames(client: CompanyEnrich, theme: Theme): Promise<string[] | null> {
  try {
    const preview = await client.companies.preview(themeQuery(theme));
    return preview.items.map((item) => item.name ?? item.id);
  } catch (error) {
    if (error instanceof PermissionDeniedError || error instanceof PaymentRequiredError) return null;
    throw error;
  }
}

/** Paid: 2 credits per returned company, +1 each with the keywords expansion. */
export async function searchCompanies(client: CompanyEnrich, theme: Theme, { pageSize, withKeywords }: { pageSize: number; withKeywords: boolean }): Promise<Company[]> {
  const page = await client.companies.search({ ...themeQuery(theme), pageSize, ...(withKeywords ? { expand: ['keywords'] } : {}) });
  return page.items;
}

/** "filters {...}; boosts categories b2b" from a semantic count or search response. */
export function describeInterpretation(interpretation: CompanySearchCount['interpretation']): string {
  const parts: string[] = [];
  if (interpretation?.filter && Object.keys(interpretation.filter).length > 0) parts.push(`filters ${JSON.stringify(interpretation.filter)}`);
  const boost = interpretation?.boost;
  for (const [kind, values] of Object.entries(boost ?? {})) {
    if (Array.isArray(values) && values.length > 0) parts.push(`boosts ${kind} ${values.join(', ')}`);
  }
  return parts.length > 0 ? parts.join('; ') : 'no filters or boosts inferred';
}

/** A one-line explanation for API errors a user can act on, or null for anything unexpected. */
export function describeApiError(error: unknown): string | null {
  if (error instanceof AuthenticationError) {
    return 'CompanyEnrich rejected the API key (401). Check COMPANYENRICH_API_KEY; keys are at https://companyenrich.com/dashboard';
  }
  if (error instanceof PaymentRequiredError) return 'CompanyEnrich returned 402: out of credits, or the plan does not include this request.';
  if (error instanceof PermissionDeniedError) return 'CompanyEnrich returned 403: this API key is not allowed to make this request.';
  if (error instanceof ValidationError || error instanceof BadRequestError) {
    const fields = Object.entries(error.errors ?? {}).map(([field, messages]) => `${field}: ${messages.join(' ')}`);
    const details = [error.detail || error.title, ...fields].filter(Boolean).join('; ') || 'no details given';
    return `CompanyEnrich rejected the query (${error.status}): ${details}. Check the theme's "filter" (field names and values: https://docs.companyenrich.com).`;
  }
  if (error instanceof RateLimitError) return 'CompanyEnrich rate limit hit (429) even after retries. Wait a minute and run again.';
  if (error instanceof ApiError) {
    return `CompanyEnrich API error ${error.status}: ${error.detail ?? error.title ?? 'no details'}${error.traceId ? ` (trace id ${error.traceId})` : ''}`;
  }
  if (error instanceof TimeoutError) return 'CompanyEnrich did not answer within 30 seconds. Try again.';
  if (error instanceof ConnectionError) return 'Could not reach api.companyenrich.com. Check your network connection.';
  if (error instanceof CompanyEnrichError) return error.message;
  return null;
}
