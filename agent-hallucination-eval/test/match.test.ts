import { describe, expect, it } from 'vitest';
import { goldAsText, grade } from '../src/lib/match.ts';
import type { AnswerType, Gold, Question } from '../src/lib/types.ts';

function question(answerType: AnswerType, gold: Gold): Question {
  return {
    id: `acme.example#${answerType}`,
    domain: 'acme.example',
    company: 'Acme',
    field: answerType,
    fieldPath: answerType,
    answerType,
    question: 'test',
    gold,
    retrievedAt: '2026-11-11',
    sourceUpdatedAt: '2026-11-01T00:00:00Z',
  };
}

const check = (answerType: AnswerType, gold: Gold, value: string) =>
  grade(question(answerType, gold), { value, confidence: 0.9 });

describe('grade', () => {
  it('treats "unknown" as an abstention for every type', () => {
    expect(check('year', 2010, 'unknown')).toBe('abstained');
    expect(check('categories', ['b2b'], 'Unknown.')).toBe('abstained');
  });

  it('employee ranges: exact bucket correct, adjacent partial, further wrong', () => {
    expect(check('employee-range', '1K-5K', '1K-5K')).toBe('correct');
    expect(check('employee-range', '1K-5K', '1,001-5,000')).toBe('correct');
    expect(check('employee-range', '1K-5K', '5K-10K')).toBe('partial');
    expect(check('employee-range', '1K-5K', '501-1K')).toBe('partial');
    expect(check('employee-range', '1K-5K', 'over-10K')).toBe('wrong');
    expect(check('employee-range', '1K-5K', 'quite a lot')).toBe('wrong');
  });

  it('revenue ranges: exact bucket correct, adjacent partial', () => {
    expect(check('revenue-range', '200m-1b', '200m-1b')).toBe('correct');
    expect(check('revenue-range', '200m-1b', 'over $1B')).toBe('partial');
    expect(check('revenue-range', '200m-1b', '10m-50m')).toBe('wrong');
  });

  it('years: exact correct, off by one partial', () => {
    expect(check('year', 2010, '2010')).toBe('correct');
    expect(check('year', 2010, '2011')).toBe('partial');
    expect(check('year', 2010, '2009')).toBe('partial');
    expect(check('year', 2010, '2008')).toBe('wrong');
  });

  it('countries: code or name', () => {
    expect(check('country', 'US', 'United States')).toBe('correct');
    expect(check('country', 'US', 'USA')).toBe('correct');
    expect(check('country', 'GB', 'United Kingdom')).toBe('correct');
    expect(check('country', 'DE', 'United States')).toBe('wrong');
    expect(check('country', 'DE', 'Atlantis')).toBe('wrong');
  });

  it('cities: case and accent folding', () => {
    expect(check('city', 'São Paulo', 'sao paulo')).toBe('correct');
    expect(check('city', 'San Francisco', 'San Francisco, California')).toBe('correct');
    expect(check('city', 'Surry Hills', 'Sydney')).toBe('wrong');
  });

  it('industries: one of the listed top-level names', () => {
    expect(check('industry', 'Media & Internet', 'media and internet')).toBe('correct');
    expect(check('industry', 'Finance', 'Software')).toBe('wrong');
  });

  it('funding stages: normalized label', () => {
    expect(check('funding-stage', 'series_b', 'Series B')).toBe('correct');
    expect(check('funding-stage', 'series_b', 'series_c')).toBe('wrong');
  });

  it('money: within 25% is correct', () => {
    expect(check('money', 8805247725, '$8.8 billion')).toBe('correct');
    expect(check('money', 8805247725, '8.8e9')).toBe('correct');
    expect(check('money', 8805247725, '$8-9 billion')).toBe('correct');
    expect(check('money', 100_000_000, '$125M')).toBe('correct');
    expect(check('money', 100_000_000, '$75M')).toBe('correct');
    expect(check('money', 100_000_000, '$126M')).toBe('wrong');
    expect(check('money', 100_000_000, 'a lot')).toBe('wrong');
  });

  it('money: wrong sign, wrong currency or a wide range is wrong', () => {
    expect(check('money', 8805247725, '-$8.8B')).toBe('wrong');
    expect(check('money', 8805247725, '¥8.8B')).toBe('wrong');
    expect(check('money', 8805247725, '$0-$17.6B')).toBe('wrong');
    expect(check('money', 8805247725, 'over $5B')).toBe('wrong');
  });

  it('employee ranges: a negative count or a range spanning buckets is wrong', () => {
    expect(check('employee-range', '1K-5K', '1–9999 employees')).toBe('wrong');
    expect(check('employee-range', '11-50', '-25')).toBe('wrong');
  });

  it('treats a curly-apostrophe "I don’t know" as an abstention', () => {
    expect(check('city', 'London', 'I don’t know')).toBe('abstained');
  });

  it('categories: same set correct, overlap partial, none wrong', () => {
    expect(check('categories', ['b2b', 'saas'], 'SaaS, B2B')).toBe('correct');
    expect(check('categories', ['b2b', 'saas'], 'b2b')).toBe('partial');
    expect(check('categories', ['b2b', 'saas'], 'b2b, saas, mobile')).toBe('partial');
    expect(check('categories', ['b2b', 'saas'], 'b2c')).toBe('wrong');
  });

  it('accepts its own gold rendering for every type, which is what the oracle relies on', () => {
    const cases: [AnswerType, Gold][] = [
      ['employee-range', 'over-10K'],
      ['revenue-range', 'under-1m'],
      ['year', 1904],
      ['country', 'AE'],
      ['city', 'Surry Hills'],
      ['industry', 'Energy, Utilities & Waste'],
      ['funding-stage', 'post_ipo_equity'],
      ['money', 22_000_000],
      ['categories', ['b2b', 'e-commerce', 'service-provider']],
    ];
    for (const [type, gold] of cases) expect(check(type, gold, goldAsText(gold))).toBe('correct');
  });
});
