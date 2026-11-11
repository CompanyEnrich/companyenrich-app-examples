import { describe, expect, it } from 'vitest';
import {
  cleanAnswer,
  employeeRangeIndex,
  fold,
  isAbstention,
  normalizeCity,
  normalizeCountry,
  normalizeFundingStage,
  normalizeIndustry,
  parseCategories,
  parseInterval,
  parseYear,
  revenueRangeIndex,
} from '../src/lib/normalize.ts';
import { EMPLOYEE_RANGES, REVENUE_RANGES } from '../src/lib/questions.ts';

describe('text helpers', () => {
  it('folds case and accents', () => {
    expect(fold('  São Paulo ')).toBe('sao paulo');
  });

  it('strips wrapping quotes and a trailing full stop', () => {
    expect(cleanAnswer(' "Paris". ')).toBe('Paris');
  });

  it.each(['unknown', 'Unknown.', '"unknown"', '“unknown”', 'N/A', "I don't know", 'I don’t know', ''])('treats %j as an abstention', (value) => {
    expect(isAbstention(value)).toBe(true);
  });

  it('does not treat a real answer as an abstention', () => {
    expect(isAbstention('Unknown Ventures')).toBe(false);
  });
});

describe('parseInterval', () => {
  it.each([
    ['8805247725', 8805247725],
    ['$8.8B', 8.8e9],
    ['8.8e9', 8.8e9],
    ['USD 2.2 billion', 2.2e9],
    ['US$ 2.2bn', 2.2e9],
    ['8,805,247,725', 8805247725],
    ['about 450 thousand', 450000],
  ])('reads %j as one number', (text, value) => {
    expect(parseInterval(text, { usd: true })).toEqual({ lo: value, hi: value });
  });

  it.each([
    ['$100M-$200M', 1e8, 2e8],
    ['$10-20 million', 1e7, 2e7],
    ['10M to 20M', 1e7, 2e7],
    ['between 1,001 and 5,000', 1001, 5000],
    ['1K–5K', 1000, 5000],
    ['$0-$17.6B', 0, 17.6e9],
  ])('reads %j as a range', (text, lo, hi) => {
    expect(parseInterval(text)).toEqual({ lo, hi });
  });

  it('reads open bounds', () => {
    expect(parseInterval('10,000+')).toEqual({ lo: 10000, hi: Infinity });
    expect(parseInterval('more than 10000')).toEqual({ lo: 10000, hi: Infinity });
    expect(parseInterval('under $1M')).toEqual({ lo: 0, hi: 1e6 });
  });

  it.each(['-$8.8B', '-25', '−25', '- 8.8 billion'])('rejects the negative amount %j', (text) => {
    expect(parseInterval(text)).toBeNull();
  });

  it.each(['¥8.8B', '€8.8 billion', '8.8B EUR', '£8.8bn', 'C$8.8B', '8.8 billion yen'])(
    'rejects %j when US dollars are expected',
    (text) => {
      expect(parseInterval(text, { usd: true })).toBeNull();
      expect(parseInterval(text)).not.toBeNull();
    },
  );

  it('rejects text with no number and backwards ranges', () => {
    expect(parseInterval('no idea')).toBeNull();
    expect(parseInterval('50-10')).toBeNull();
  });
});

describe('range buckets', () => {
  it('maps every employee label to its own index', () => {
    EMPLOYEE_RANGES.forEach((label, index) => expect(employeeRangeIndex(label)).toBe(index));
  });

  it('maps every revenue label to its own index', () => {
    REVENUE_RANGES.forEach((label, index) => expect(revenueRangeIndex(label)).toBe(index));
  });

  it.each([
    ['1,001-5,000 employees', '1K-5K'],
    ['about 8,000', '5K-10K'],
    ['10,000+', 'over-10K'],
    ['more than 10000', 'over-10K'],
    ['over-10k', 'over-10K'],
    ['fewer than 11', '1-10'],
    ['25', '11-50'],
    ['1,000-5,000', '1K-5K'],
    ['10,000 to 50,000', 'over-10K'],
  ])('reads employee answer %j as %s', (text, label) => {
    expect(employeeRangeIndex(text)).toBe(EMPLOYEE_RANGES.indexOf(label as (typeof EMPLOYEE_RANGES)[number]));
  });

  it.each([
    ['$14 billion', 'over-1b'],
    ['$100M-$200M', '100m-200m'],
    ['under $1M', 'under-1m'],
    ['30 million', '10m-50m'],
  ])('reads revenue answer %j as %s', (text, label) => {
    expect(revenueRangeIndex(text)).toBe(REVENUE_RANGES.indexOf(label as (typeof REVENUE_RANGES)[number]));
  });

  it.each(['a few thousand', '1–9999 employees', '1-9999', 'over 1,000', '-25', '0'])(
    'maps %j to no bucket: no number, negative, or a range wider than one bucket',
    (text) => {
      expect(employeeRangeIndex(text)).toBeNull();
    },
  );

  it('rejects revenue in another currency', () => {
    expect(revenueRangeIndex('¥14 billion')).toBeNull();
  });
});

describe('years', () => {
  it('finds a four-digit year', () => {
    expect(parseYear('Founded in 2010.')).toBe(2010);
    expect(parseYear('1904')).toBe(1904);
    expect(parseYear('the nineties')).toBeNull();
  });
});

describe('countries', () => {
  it.each([
    ['US', 'US'],
    ['us', 'US'],
    ['United States', 'US'],
    ['the United States of America', 'US'],
    ['U.S.A.', 'US'],
    ['UK', 'GB'],
    ['United Kingdom', 'GB'],
    ['England', 'GB'],
    ['Türkiye', 'TR'],
    ['Turkey', 'TR'],
    ['Deutschland', null],
    ['Germany', 'DE'],
    ['The Netherlands', 'NL'],
  ])('normalizes %j to %s', (text, code) => {
    expect(normalizeCountry(text)).toBe(code);
  });
});

describe('cities', () => {
  it('folds case and accents and drops the region', () => {
    expect(normalizeCity('São Paulo, Brazil')).toBe('sao paulo');
    expect(normalizeCity('SAO PAULO')).toBe('sao paulo');
    expect(normalizeCity('Zürich')).toBe('zurich');
  });

  it('resolves common short names', () => {
    expect(normalizeCity('NYC')).toBe('new york');
    expect(normalizeCity('New York City')).toBe('new york');
  });
});

describe('industries, stages and categories', () => {
  it('compares industries by their top-level name', () => {
    expect(normalizeIndustry('Finance/Credit Cards & Transaction Processing')).toBe('finance');
    expect(normalizeIndustry('Media and Internet')).toBe(normalizeIndustry('Media & Internet'));
  });

  it('normalizes funding stage spellings', () => {
    expect(normalizeFundingStage('Series A')).toBe('series_a');
    expect(normalizeFundingStage('series-a round')).toBe('series_a');
    expect(normalizeFundingStage('post_ipo_equity')).toBe('post_ipo_equity');
  });

  it('parses a category list', () => {
    expect(parseCategories('B2B, SaaS and e commerce')).toEqual(new Set(['b2b', 'saas', 'e-commerce']));
    expect(parseCategories('service provider; ecommerce')).toEqual(new Set(['service-provider', 'e-commerce']));
  });
});
