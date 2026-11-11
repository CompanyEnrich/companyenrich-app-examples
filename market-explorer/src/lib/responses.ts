/** JSON shapes returned by the route handlers, shared by server and browser code. */
import type { Interpretation } from './describe';
import type { Industry } from './filter';
import type { GridResult } from './grid';

export interface CountResponse {
  count: number;
  total: number;
}

export interface InterpretResponse {
  query: string;
  count: number;
  total: number;
  interpretation: Interpretation | null;
}

export type GridResponse = GridResult;

/** A company as the sample panel shows it. Preview items carry fewer fields. */
export interface SampleCompany {
  id: string;
  name: string;
  logoUrl: string;
  industry: string | null;
  domain: string | null;
  country: string | null;
  employees: string | null;
}

export type PreviewResponse =
  | { available: true; total: number; items: SampleCompany[] }
  | { available: false; reason: string };

export interface SearchResponse {
  items: SampleCompany[];
  /** Free count of matches, checked before the paid call. */
  matches: number;
  /** Credits the search cost at list price (0 when skipped). */
  credits: number;
  /** True when the free count was 0 and the paid call was not made. */
  skipped: boolean;
}

export interface Suggestion {
  value: string | number;
  label: string;
}

export interface AutocompleteResponse {
  items: Suggestion[];
}

export interface RegionsResponse {
  items: { value: string; label: string; parent: string | null }[];
}

export interface IndustriesResponse {
  items: Industry[];
}

export interface CapabilitiesResponse {
  previews: boolean;
}
