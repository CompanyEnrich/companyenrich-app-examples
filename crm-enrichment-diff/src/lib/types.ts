import type { Company } from '@companyenrich/sdk';

/** How a CRM cell compares with the enriched value. */
export type ChangeType = 'fill' | 'conflict' | 'same' | 'api-missing';

/** What the rules propose to do with a cell. `none` means there is nothing to change. */
export type Action = 'update' | 'review' | 'skip' | 'none';

export type NormalizerName =
  | 'text'
  | 'companyName'
  | 'domain'
  | 'url'
  | 'country'
  | 'employees'
  | 'revenue'
  | 'year';

/**
 * How a range value from the API (such as `51-200` employees) is written to the CRM:
 * `label` writes the range as text, `lower-bound` writes its lowest number for number properties.
 */
export type WriteAs = 'label' | 'lower-bound';

export interface FieldMapping {
  /** Column header in the CRM export. */
  column: string;
  /** Dot path into the CompanyEnrich company, such as `location.country.name`. */
  path: string;
  normalizer: NormalizerName;
  /** HubSpot property internal name, used by `apply --hubspot`. */
  hubspotProperty?: string;
  writeAs?: WriteAs;
}

export interface Mapping {
  recordIdColumn: string;
  nameColumn: string;
  /** Columns to read the domain from, in order of preference (a domain or a website URL). */
  domainColumns: string[];
  fields: FieldMapping[];
}

export type Policy = 'neverOverwrite' | 'fillOnlyIfEmpty' | 'trustApi' | 'unlisted';

export interface Rules {
  neverOverwrite: string[];
  fillOnlyIfEmpty: string[];
  trustApi: string[];
}

/** Outcome of enriching one domain. Only `found` carries a company. */
export type EnrichStatus = 'found' | 'not-found' | 'invalid-domain' | 'pending' | 'error';

export interface EnrichResult {
  domain: string;
  status: EnrichStatus;
  company?: Company;
  /** Error detail for `error` results. */
  message?: string;
}

/** Row-level status, which adds the cases where no lookup was possible. */
export type RecordStatus = EnrichStatus | 'no-domain' | 'not-enriched';

export interface CrmRecord {
  recordId: string;
  name: string;
  /** Normalized domain, or null when no domain column held a usable value. */
  domain: string | null;
  /** The raw value we tried to read a domain from, for error messages. */
  rawDomain: string;
  row: Record<string, string>;
}

export interface DiffCell {
  recordId: string;
  company: string;
  domain: string;
  column: string;
  field: string;
  change: ChangeType;
  crmValue: string;
  /** The API value as shown to a reviewer, such as `51-200`. */
  apiValue: string;
  /** The value that would be written to the CRM, or empty when there is none. */
  newValue: string;
  action: Action;
  reason: Reason;
  /** Extra context for the reviewer, such as an unreadable CRM value. */
  note?: string;
}

export type Reason =
  | 'match'
  | 'api-missing'
  | 'protected'
  | 'fill-empty'
  | 'crm-has-value'
  | 'trust-api'
  | 'no-rule'
  | 'not-writable';

export interface RecordSummary {
  recordId: string;
  company: string;
  domain: string;
  status: RecordStatus;
  /** Other records in the export with the same domain. */
  duplicateOf: string[];
  message?: string;
}
