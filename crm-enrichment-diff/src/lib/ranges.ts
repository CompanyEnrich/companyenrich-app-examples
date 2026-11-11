/**
 * Employee counts and revenue arrive in many shapes: `120`, `1,200`, `$450M`, `1.2B`,
 * `51-200`, `1K-5K`, `10,001+`, `over-10K`, `under-1m`. Parsing all of them into a
 * numeric interval lets a CRM count of 120 match an API range of `51-200`.
 */

export interface Interval {
  min: number;
  /** `Infinity` for open-ended ranges such as `over-10K`. */
  max: number;
  /** True when `min` itself is not included, as in "over 10K". */
  minExclusive?: boolean;
  /** True when `max` itself is not included, as in "under 1M". */
  maxExclusive?: boolean;
}

export type RangeKind = 'employees' | 'revenue';

/**
 * The v2 enums, with their exact bounds. Employee ranges are whole-number buckets that do not
 * overlap: `501-1K` ends at 1,000, so `1K-5K` starts at 1,001, and `over-10K` starts at 10,001.
 * Revenue ranges in USD are continuous: neighbours share their boundary, while `under-1m` and
 * `over-1b` exclude 1M and 1B.
 */
const API_RANGES: Record<RangeKind, Record<string, Interval>> = {
  employees: {
    '1-10': { min: 1, max: 10 },
    '11-50': { min: 11, max: 50 },
    '51-200': { min: 51, max: 200 },
    '201-500': { min: 201, max: 500 },
    '501-1K': { min: 501, max: 1_000 },
    '1K-5K': { min: 1_001, max: 5_000 },
    '5K-10K': { min: 5_001, max: 10_000 },
    'over-10K': { min: 10_001, max: Infinity },
  },
  revenue: {
    'under-1m': { min: 0, max: 1e6, maxExclusive: true },
    '1m-10m': { min: 1e6, max: 1e7 },
    '10m-50m': { min: 1e7, max: 5e7 },
    '50m-100m': { min: 5e7, max: 1e8 },
    '100m-200m': { min: 1e8, max: 2e8 },
    '200m-1b': { min: 2e8, max: 1e9 },
    'over-1b': { min: 1e9, max: Infinity, minExclusive: true },
  },
};

const MULTIPLIERS: Record<string, number> = { k: 1e3, m: 1e6, mm: 1e6, b: 1e9, bn: 1e9, t: 1e12 };

function parseAmount(text: string): number | null {
  const match = text.match(/^(\d+(?:\.\d+)?)(k|mm|m|bn|b|t)?$/);
  if (!match) return null;
  const multiplier = MULTIPLIERS[match[2] ?? ''] ?? 1;
  return Math.round(Number(match[1]) * multiplier);
}

/** Parses a free-form CRM value. `over 10K` excludes 10,000; `10,001+` includes 10,001. */
export function parseInterval(raw: string): Interval | null {
  const text = raw
    .toLowerCase()
    .replace(/[$€£,\s]|usd|eur|employees?|people|staff/g, '')
    .replace(/[–—]/g, '-');
  if (!text) return null;

  const over = text.match(/^(?:over|above|morethan|>)-?(.+)$/);
  if (over) {
    const min = parseAmount(over[1] ?? '');
    return min === null ? null : { min, max: Infinity, minExclusive: true };
  }

  const atLeast = text.match(/^(.+)\+$/);
  if (atLeast) {
    const min = parseAmount(atLeast[1] ?? '');
    return min === null ? null : { min, max: Infinity };
  }

  const under = text.match(/^(?:under|below|lessthan|<)-?(.+)$/);
  if (under) {
    const max = parseAmount(under[1] ?? '');
    return max === null ? null : { min: 0, max, maxExclusive: true };
  }

  const range = text.match(/^(.+?)(?:-|to)(.+)$/);
  if (range) {
    const min = parseAmount(range[1] ?? '');
    const max = parseAmount(range[2] ?? '');
    return min === null || max === null || min > max ? null : { min, max };
  }

  const value = parseAmount(text);
  return value === null ? null : { min: value, max: value };
}

/** Employee counts are whole numbers, so "over 10K" is the same as 10,001 or more. */
export function asWholeNumbers(interval: Interval): Interval {
  return {
    min: interval.minExclusive ? Math.floor(interval.min) + 1 : interval.min,
    max: interval.maxExclusive ? Math.ceil(interval.max) - 1 : interval.max,
  };
}

/** An API range label, with the exact enum bounds when it is a known v2 value. */
export function apiRange(kind: RangeKind, label: string): Interval | null {
  return API_RANGES[kind][label.trim()] ?? parseInterval(label);
}

/** True when every value the inner interval allows is also inside the outer one. */
export function isWithin(inner: Interval, outer: Interval): boolean {
  const lowerOk =
    inner.min > outer.min || (inner.min === outer.min && (!outer.minExclusive || Boolean(inner.minExclusive)));
  const upperOk =
    inner.max < outer.max || (inner.max === outer.max && (!outer.maxExclusive || Boolean(inner.maxExclusive)));
  return lowerOk && upperOk;
}
