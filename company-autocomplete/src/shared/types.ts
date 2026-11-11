// The JSON contract between the server handler and the browser components.
// It is deliberately small: the browser gets only the fields a form needs,
// never the full CompanyEnrich payload and never the API key.

export type EmployeeRange = '1-10' | '11-50' | '51-200' | '201-500' | '501-1K' | '1K-5K' | '5K-10K' | 'over-10K';

export type RevenueRange = 'under-1m' | '1m-10m' | '10m-50m' | '50m-100m' | '100m-200m' | '200m-1b' | 'over-1b';

/** One autocomplete suggestion. Free to fetch. */
export interface CompanySuggestion {
  domain: string;
  name: string;
  logoUrl: string | null;
}

/** The enriched fields used to pre-fill a form. Costs 1 credit per fresh lookup. */
export interface CompanyProfile {
  id: string;
  domain: string;
  name: string;
  logoUrl: string | null;
  industry: string | null;
  employees: EmployeeRange | null;
  revenue: RevenueRange | null;
  foundedYear: number | null;
  country: { code: string; name: string } | null;
  state: string | null;
  city: string | null;
  linkedinUrl: string | null;
}

/** `GET ?q=` */
export interface SuggestResponse {
  items: CompanySuggestion[];
}

/** `GET ?domain=` */
export interface EnrichResponse {
  company: CompanyProfile;
  /** Credits this request spent: 1 for a fresh enrichment, 0 when served from the cache. */
  credits: number;
  cached: boolean;
}

export type ErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'rate_limited'
  | 'budget_exhausted'
  | 'not_configured'
  | 'unavailable'
  | 'upstream_error';

/** Every non-2xx response. `message` is safe to show to end users. */
export interface ErrorResponse {
  error: { code: ErrorCode; message: string };
}
