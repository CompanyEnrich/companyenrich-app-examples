import { countryCode, foldCountry } from './countries.js';
import { normalizeDomain } from './domains.js';
import { apiRange, asWholeNumbers, isWithin, parseInterval, type RangeKind } from './ranges.js';
import type { NormalizerName, WriteAs } from './types.js';

export interface Comparison {
  same: boolean;
  /** Shown to the reviewer, for example when the CRM value cannot be read. */
  note?: string;
}

/**
 * A normalizer knows how to compare one kind of value. Both inputs are non-empty strings:
 * the raw CRM cell and the API value converted to text.
 */
export interface Normalizer {
  /** Whether a CRM cell means "no value" for this kind of field. */
  isEmpty(crm: string): boolean;
  compare(crm: string, api: string): Comparison;
  /** The value to write to the CRM, or null when the API value has no writable form. */
  toCrm(api: string, writeAs: WriteAs): string | null;
}

/** Lowercase, strip accents, treat `&` as `and`, collapse punctuation and whitespace. */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'plc', 'gmbh', 'ag', 'sa', 'se', 'nv', 'bv', 'ab', 'asa', 'oy', 'oyj', 'srl', 'spa', 'pty', 'kk',
]);

/** `Stripe, Inc.` and `stripe` compare equal; `Meta` and `Facebook` do not. */
function foldCompanyName(value: string): string {
  const words = foldText(value.replace(/\./g, '')).split(' ');
  while (words.length > 1 && LEGAL_SUFFIXES.has(words.at(-1) ?? '')) words.pop();
  return words.join(' ');
}

/** `https://www.linkedin.com/company/stripe/?trk=x` -> `linkedin.com/company/stripe`. */
export function canonicalUrl(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\d*\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

const passThrough = (api: string): string => api;

/** Placeholders that cannot be a real value in any field. */
const PLACEHOLDERS = new Set(['', '-', '--', 'n/a', '#n/a', 'null']);
/** Words that mean "unknown" in a number field but can be real elsewhere: `NA` is Namibia's country code. */
const NUMBER_PLACEHOLDERS = new Set([...PLACEHOLDERS, 'na', 'none', 'unknown']);

const placeholderIn =
  (placeholders: Set<string>) =>
  (value: string): boolean =>
    placeholders.has(value.trim().toLowerCase());
const isBlank = placeholderIn(PLACEHOLDERS);
const isBlankNumber = placeholderIn(NUMBER_PLACEHOLDERS);

function equalBy(fold: (value: string) => string): Normalizer['compare'] {
  return (crm, api) => ({ same: fold(crm) === fold(api) });
}

function rangeNormalizer(unit: string, kind: RangeKind): Normalizer {
  return {
    isEmpty: isBlankNumber,
    compare(crm, api) {
      const parsed = parseInterval(crm);
      const crmInterval = parsed && kind === 'employees' ? asWholeNumbers(parsed) : parsed;
      const apiInterval = apiRange(kind, api);
      if (!apiInterval) return { same: foldText(crm) === foldText(api) };
      if (!crmInterval) return { same: false, note: `CRM value "${crm}" is not a readable ${unit}` };
      return { same: isWithin(crmInterval, apiInterval) };
    },
    toCrm(api, writeAs) {
      if (writeAs === 'label') return api;
      const interval = apiRange(kind, api);
      return interval && interval.min > 0 ? String(interval.min) : null;
    },
  };
}

export const normalizers: Record<NormalizerName, Normalizer> = {
  text: { isEmpty: isBlank, compare: equalBy(foldText), toCrm: passThrough },

  companyName: { isEmpty: isBlank, compare: equalBy(foldCompanyName), toCrm: passThrough },

  domain: {
    isEmpty: isBlank,
    compare(crm, api) {
      const crmDomain = normalizeDomain(crm);
      if (!crmDomain) return { same: false, note: `CRM value "${crm}" is not a domain` };
      return { same: crmDomain === normalizeDomain(api) };
    },
    toCrm: passThrough,
  },

  url: { isEmpty: isBlank, compare: equalBy(canonicalUrl), toCrm: passThrough },

  country: {
    isEmpty: isBlank,
    compare(crm, api) {
      const crmCode = countryCode(crm);
      const apiCode = countryCode(api);
      if (crmCode && apiCode) return { same: crmCode === apiCode };
      if (foldCountry(crm) === foldCountry(api)) return { same: true };
      if (!crmCode) return { same: false, note: `CRM value "${crm}" is not a recognized country` };
      return { same: false };
    },
    toCrm: passThrough,
  },

  employees: rangeNormalizer('employee count', 'employees'),

  revenue: rangeNormalizer('revenue amount', 'revenue'),

  year: {
    isEmpty: isBlankNumber,
    compare(crm, api) {
      const year = crm.match(/\b(1[5-9]\d\d|20\d\d)\b/)?.[1];
      if (!year) return { same: false, note: `CRM value "${crm}" is not a year` };
      return { same: year === api.trim() };
    },
    toCrm: passThrough,
  },
};

export const NORMALIZER_NAMES = Object.keys(normalizers) as NormalizerName[];
