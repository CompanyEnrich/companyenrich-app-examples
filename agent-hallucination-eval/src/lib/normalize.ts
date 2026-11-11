import { EMPLOYEE_RANGES, REVENUE_RANGES } from './questions.ts';

/**
 * Lowercase, trimmed, accents removed ("São Paulo" becomes "sao paulo"), with curly quotes made
 * straight and every dash or minus sign made a plain hyphen.
 */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—−]/g, '-')
    .toLowerCase()
    .trim();
}

/** Removes wrapping quotes and a trailing full stop: `"Paris".` becomes `Paris`. */
export function cleanAnswer(value: string): string {
  return value.trim().replace(/^["'“”‘’]+|["'“”‘’.!]+$/g, '').trim();
}

const ABSTENTIONS = new Set(['', 'unknown', 'n/a', 'na', 'not sure', 'unsure', "i don't know", 'i do not know']);

export function isAbstention(value: string): boolean {
  return ABSTENTIONS.has(fold(cleanAnswer(value)));
}

const SCALES: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mm: 1e6,
  mn: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  t: 1e12,
  tn: 1e12,
  trillion: 1e12,
};

/** A numeric answer as an inclusive interval. A single number has `lo === hi`. */
export interface Interval {
  lo: number;
  hi: number;
}

const NUMBER = /(\d[\d,]*(?:\.\d+)?(?:e[+-]?\d+)?)\s*(thousand|million|billion|trillion|bn|mn|mm|tn|k|m|b|t)?(?![a-z\d])/g;
const RANGE_JOIN = /^\s*(-|to|and)\s*\$?\s*$/;
const NON_USD =
  /[€£¥₹₩₽]|[a-z]\$|\b(eur|euros?|gbp|pounds?|jpy|yen|cny|rmb|yuan|inr|rupees?|krw|won|chf|francs?|aud|cad|sek|nok|dkk|brl|reais)\b/;
const OPEN_ABOVE = /\+|>|\b(over|more than|above|greater than|at least)\b/;
const OPEN_BELOW = /<|\b(under|less than|below|fewer than|up to)\b/;

/**
 * Reads a numeric answer: a number ("8.8B", "8.8e9", "$8,805,247,725"), a range ("$10-20 million",
 * "1,001 to 5,000") or an open bound ("10,000+", "under $1M"). Returns null when there is no number,
 * when it is negative, and, with `usd`, when the amount is in another currency ("¥8.8B", "C$5M").
 */
export function parseInterval(text: string, { usd = false } = {}): Interval | null {
  const answer = fold(text).replace(/us\$/g, '$');
  if (usd && NON_USD.test(answer)) return null;

  const numbers = [...answer.matchAll(NUMBER)].map((match) => ({
    value: Number(match[1]!.replace(/,/g, '')),
    scale: match[2] ? SCALES[match[2]]! : null,
    start: match.index,
    end: match.index + match[0].length,
  }));
  const [first, second] = numbers;
  if (!first || !Number.isFinite(first.value)) return null;
  if (/-\s*\$?\s*$/.test(answer.slice(0, first.start))) return null;

  if (second && RANGE_JOIN.test(answer.slice(first.end, second.start))) {
    // In "$10-20 million" the first number takes the second one's scale.
    const lo = first.value * (first.scale ?? second.scale ?? 1);
    const hi = second.value * (second.scale ?? 1);
    return lo <= hi ? { lo, hi } : null;
  }
  const value = first.value * (first.scale ?? 1);
  if (OPEN_ABOVE.test(answer)) return { lo: value, hi: Infinity };
  if (OPEN_BELOW.test(answer)) return { lo: 0, hi: value };
  return { lo: value, hi: value };
}

interface Bucket {
  label: string;
  /** Smallest value in the bucket. */
  min: number;
  /** Smallest value in the next bucket. */
  next: number;
}

function buckets(labels: readonly string[], minimums: number[]): Bucket[] {
  return labels.map((label, i) => ({ label, min: minimums[i]!, next: minimums[i + 1] ?? Infinity }));
}

const EMPLOYEE_BUCKETS = buckets(EMPLOYEE_RANGES, [1, 11, 51, 201, 501, 1001, 5001, 10001]);
const REVENUE_BUCKETS = buckets(REVENUE_RANGES, [0, 1e6, 1e7, 5e7, 1e8, 2e8, 1e9]);

/**
 * Maps a range answer to a bucket index. Accepts the exact label ("1K-5K"), a single number
 * ("about 8,000"), or a range or open bound that fits inside one bucket ("1,001-5,000", "10,000+").
 * A range that spans several buckets ("1-9999") is not an answer, so it maps to nothing.
 */
function rangeIndex(text: string, table: Bucket[], usd: boolean): number | null {
  const byLabel = table.findIndex((bucket) => fold(bucket.label) === fold(text));
  if (byLabel !== -1) return byLabel;

  const interval = parseInterval(text, { usd });
  if (!interval) return null;
  const { lo, hi } = interval;
  const index =
    lo === hi
      ? table.findIndex((b) => lo >= b.min && lo < b.next)
      : // Labels share their edges ("1K-5K", "5K-10K"), so a range may start one below a bucket's minimum.
        table.findIndex((b) => lo >= b.min - 1 && hi <= b.next);
  return index === -1 ? null : index;
}

export const employeeRangeIndex = (text: string) => rangeIndex(text, EMPLOYEE_BUCKETS, false);
export const revenueRangeIndex = (text: string) => rangeIndex(text, REVENUE_BUCKETS, true);

export function parseYear(text: string): number | null {
  const match = /\b(1[5-9]\d{2}|20\d{2})\b/.exec(text);
  return match ? Number(match[1]) : null;
}

const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'US',
  'u s': 'US',
  'u s a': 'US',
  america: 'US',
  'united states of america': 'US',
  uk: 'GB',
  'u k': 'GB',
  britain: 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'south korea': 'KR',
  korea: 'KR',
  russia: 'RU',
  turkey: 'TR',
  'czech republic': 'CZ',
  holland: 'NL',
  uae: 'AE',
};

/** Country name to ISO code for every region the runtime knows, built once from `Intl.DisplayNames`. */
const COUNTRY_CODES: Map<string, string> = (() => {
  const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
  const codes = new Map<string, string>();
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const first of letters) {
    for (const second of letters) {
      const code = first + second;
      // Skip retired and alias codes (DD, UK, ...) so "Germany" maps to DE and "United Kingdom" to GB.
      if (Intl.getCanonicalLocales(`und-${code}`)[0] !== `und-${code}`) continue;
      const name = names.of(code);
      if (name && name !== code) codes.set(foldCountry(name), code);
    }
  }
  return codes;
})();
const KNOWN_CODES = new Set(COUNTRY_CODES.values());

function foldCountry(text: string): string {
  return fold(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

/** Returns an ISO 3166-1 alpha-2 code for a country name or code, or null when it is not recognized. */
export function normalizeCountry(text: string): string | null {
  const answer = foldCountry(text);
  const byName = COUNTRY_ALIASES[answer] ?? COUNTRY_CODES.get(answer);
  if (byName) return byName;
  const upper = answer.toUpperCase();
  return KNOWN_CODES.has(upper) ? upper : null;
}

const CITY_ALIASES: Record<string, string> = {
  nyc: 'new york',
  'new york city': 'new york',
  sf: 'san francisco',
};

/** Case and accent folding, keeping only the city part of "Berlin, Germany". */
export function normalizeCity(text: string): string {
  const city = fold(text.split(',')[0] ?? '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return CITY_ALIASES[city] ?? city;
}

/** "Finance/Credit Cards" and "finance" both become "finance"; "&" and "and" are treated alike. */
export function normalizeIndustry(text: string): string {
  return fold(text.split('/')[0] ?? '')
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Series A", "series-a" and "SERIES_A round" all become "series_a". */
export function normalizeFundingStage(text: string): string {
  return fold(text)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_round$/, '');
}

/** "B2B, SaaS and e commerce" becomes {b2b, saas, e-commerce}. */
export function parseCategories(text: string): Set<string> {
  const items = fold(text)
    .split(/[,;|\n]|\band\b/)
    .map((item) => item.trim().replace(/[\s_]+/g, '-'))
    .map((item) => (item === 'ecommerce' ? 'e-commerce' : item))
    .filter((item) => item !== '');
  return new Set(items);
}
