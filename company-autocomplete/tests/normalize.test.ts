import { describe, expect, it } from 'vitest';
import { normalizeDomain, normalizeQuery } from '../src/shared/normalize';

describe('normalizeDomain', () => {
  it.each([
    ['stripe.com', 'stripe.com'],
    ['https://www.stripe.com/pricing', 'stripe.com'],
    ['HTTP://WWW.Stripe.COM:443/docs?tab=api#top', 'stripe.com'],
    ['  stripe.com.  ', 'stripe.com'],
    ['jane@stripe.com', 'stripe.com'],
    ['https://user:secret@stripe.com/login', 'stripe.com'],
    ['dashboard.stripe.com', 'dashboard.stripe.com'],
    ['bbc.co.uk', 'bbc.co.uk'],
    ['münchen-city-immobilien.de', 'münchen-city-immobilien.de'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each(['', 'stripe', 'not a domain', 'https://', '-stripe.com', 'stripe..com', 'stripe.c', 'localhost:3000'])(
    'rejects %j',
    (input) => {
      expect(normalizeDomain(input)).toBeNull();
    },
  );
});

describe('normalizeQuery', () => {
  it.each([
    ['Stri', 'stri'],
    ['  open ai ', 'openai'],
    ['https://www.stri', 'stri'],
    ['https://www.stripe.com/pricing', 'stripe.com'],
    ['jane@stripe.com', 'stripe.com'],
    ['www.', ''],
    ['AT&T', 'att'],
    ['<stri>"!', 'stri'],
    ["o'reilly", 'oreilly'],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeQuery(input)).toBe(expected);
  });
});
