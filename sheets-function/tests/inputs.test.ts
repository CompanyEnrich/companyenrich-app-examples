import { describe, expect, it } from 'vitest';
import { setup, COMPANIES } from './helpers.js';

const { script } = setup();

describe('normalizeDomain_', () => {
  it.each([
    ['stripe.com', 'stripe.com'],
    ['  Stripe.COM ', 'stripe.com'],
    ['https://www.stripe.com/pricing?x=1#top', 'stripe.com'],
    ['http://stripe.com:8080/', 'stripe.com'],
    ['jane.doe@stripe.com', 'stripe.com'],
    ['medium.com/@someone', 'medium.com'],
    ['stripe.com.', 'stripe.com'],
    ['', ''],
    [null, ''],
  ])('%j becomes %j', (input, expected) => {
    expect(script.normalizeDomain_(input)).toBe(expected);
  });
});

describe('isDomain_', () => {
  it.each(['stripe.com', 'x.ai', 'bbc.co.uk', 'my-company.io', 'xn--80ak6aa92e.com'])('accepts %s', (domain) => {
    expect(script.isDomain_(domain)).toBe(true);
  });

  it.each(['website', 'not a domain.com', '-bad.com', 'bad-.com', 'stripe.c', '1.2.3.4', 'a'.repeat(241) + '.com'])(
    'rejects %s',
    (domain) => {
      expect(script.isDomain_(domain)).toBe(false);
    },
  );
});

describe('resolveFieldPath_', () => {
  it('accepts paths case-insensitively and short aliases', () => {
    expect(script.resolveFieldPath_('name')).toBe('name');
    expect(script.resolveFieldPath_('FoundedYear')).toBe('foundedYear');
    expect(script.resolveFieldPath_('location.country.name')).toBe('location.country.name');
    expect(script.resolveFieldPath_('Country')).toBe('location.country.name');
    expect(script.resolveFieldPath_('linkedin')).toBe('socials.linkedinUrl');
  });

  it('explains unknown, grouped, paid-only and missing fields', () => {
    expect(() => script.resolveFieldPath_('nmae')).toThrow('Unknown field "nmae"');
    expect(() => script.resolveFieldPath_('location')).toThrow(/group of fields\. Pick one: location\.country\.name/);
    expect(() => script.resolveFieldPath_('technologies')).toThrow('only returned with a paid expansion');
    expect(() => script.resolveFieldPath_('financial.totalFunding')).toThrow('paid expansion');
    expect(() => script.resolveFieldPath_('')).toThrow('Missing field');
  });
});

describe('readField_', () => {
  const acme = COMPANIES['acme.example'];

  it('reads nested paths and formats values for cells', () => {
    expect(script.readField_(acme, 'location.country.name')).toBe('United States');
    expect(script.readField_(acme, 'foundedYear')).toBe(1949);
    expect(script.readField_(acme, 'industries')).toBe('Manufacturing, Retail');
  });

  it('returns an empty cell for missing values', () => {
    expect(script.readField_(acme, 'location.address')).toBe('');
    expect(script.readField_(acme, 'location.postalCode')).toBe('');
    expect(script.readField_(COMPANIES['globex.example'], 'location.city.name')).toBe('');
  });
});
