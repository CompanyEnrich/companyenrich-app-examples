import { describe, expect, it } from 'vitest';
import { countryCode } from '../src/lib/countries.js';
import { normalizeDomain } from '../src/lib/domains.js';
import { canonicalUrl, normalizers } from '../src/lib/normalizers.js';
import { isWithin, parseInterval } from '../src/lib/ranges.js';

const same = (name: keyof typeof normalizers, crm: string, api: string) => normalizers[name].compare(crm, api).same;

describe('employee counts vs ranges', () => {
  it('treats a count inside the API range as the same', () => {
    expect(same('employees', '120', '51-200')).toBe(true);
    expect(same('employees', '1,200', '1K-5K')).toBe(true);
    expect(same('employees', '7600', '5K-10K')).toBe(true);
    expect(same('employees', '100000', 'over-10K')).toBe(true);
    expect(same('employees', '1.2k', '1K-5K')).toBe(true);
  });

  it('treats a count outside the range as a conflict', () => {
    expect(same('employees', '120', '5K-10K')).toBe(false);
    expect(same('employees', '4000', 'over-10K')).toBe(false);
  });

  it('compares a CRM range with an API range', () => {
    expect(same('employees', '1001-5000', '1K-5K')).toBe(true);
    expect(same('employees', '10,001+', 'over-10K')).toBe(true);
    expect(same('employees', '201-500', '51-200')).toBe(false);
  });

  it('explains an unreadable CRM value', () => {
    expect(normalizers.employees.compare('lots', '51-200')).toEqual({
      same: false,
      note: 'CRM value "lots" is not a readable employee count',
    });
  });

  it('writes the range label or its lower bound', () => {
    expect(normalizers.employees.toCrm('51-200', 'label')).toBe('51-200');
    expect(normalizers.employees.toCrm('51-200', 'lower-bound')).toBe('51');
    expect(normalizers.employees.toCrm('over-10K', 'lower-bound')).toBe('10001');
    expect(normalizers.employees.toCrm('1K-5K', 'lower-bound')).toBe('1001');
  });
});

describe('revenue numbers vs ranges', () => {
  it('matches HubSpot-style numbers and shorthand against API ranges', () => {
    expect(same('revenue', '2000000000', 'over-1b')).toBe(true);
    expect(same('revenue', '$1.2B', 'over-1b')).toBe(true);
    expect(same('revenue', '450000000.00', '200m-1b')).toBe(true);
    expect(same('revenue', '$25M', '10m-50m')).toBe(true);
    expect(same('revenue', '$10M-$50M', '10m-50m')).toBe(true);
  });

  it('flags revenue outside the range', () => {
    expect(same('revenue', '5000000', '200m-1b')).toBe(false);
  });

  it('has no lower bound to write for under-1m', () => {
    expect(normalizers.revenue.toCrm('under-1m', 'lower-bound')).toBeNull();
    expect(normalizers.revenue.toCrm('200m-1b', 'lower-bound')).toBe('200000000');
  });
});

describe('exact v2 range bounds', () => {
  it('uses whole-number employee buckets that do not overlap', () => {
    expect(same('employees', '10000', 'over-10K')).toBe(false);
    expect(same('employees', '10000', '5K-10K')).toBe(true);
    expect(same('employees', '10001', 'over-10K')).toBe(true);
    expect(same('employees', '1000', '1K-5K')).toBe(false);
    expect(same('employees', '1000', '501-1K')).toBe(true);
    expect(same('employees', '1001', '1K-5K')).toBe(true);
    expect(same('employees', 'over 10K', 'over-10K')).toBe(true);
  });

  it('excludes 1M from under-1m and 1B from over-1b', () => {
    expect(same('revenue', '1000000', 'under-1m')).toBe(false);
    expect(same('revenue', '999999', 'under-1m')).toBe(true);
    expect(same('revenue', '1000000', '1m-10m')).toBe(true);
    expect(same('revenue', '1000000000', 'over-1b')).toBe(false);
    expect(same('revenue', '1000000000', '200m-1b')).toBe(true);
    expect(same('revenue', '1000000001', 'over-1b')).toBe(true);
    expect(same('revenue', 'over $1B', 'over-1b')).toBe(true);
  });

  it('lets a shared revenue boundary match both neighbours', () => {
    expect(same('revenue', '$10M', '1m-10m')).toBe(true);
    expect(same('revenue', '$10M', '10m-50m')).toBe(true);
  });
});

describe('empty values depend on the field', () => {
  it('reads NA as Namibia in a country field, not as missing', () => {
    expect(normalizers.country.isEmpty('NA')).toBe(false);
    expect(same('country', 'NA', 'Namibia')).toBe(true);
    expect(same('country', 'NA', 'United States')).toBe(false);
    expect(normalizers.country.isEmpty('N/A')).toBe(true);
  });

  it('treats unambiguous placeholders as empty everywhere and words only in number fields', () => {
    for (const name of ['text', 'companyName', 'domain', 'url', 'country', 'employees', 'revenue', 'year'] as const) {
      for (const value of ['', '  ', '-', 'n/a', '#N/A', 'null']) expect(normalizers[name].isEmpty(value)).toBe(true);
    }
    expect(normalizers.employees.isEmpty('NA')).toBe(true);
    expect(normalizers.revenue.isEmpty('unknown')).toBe(true);
    expect(normalizers.text.isEmpty('None')).toBe(false);
  });
});

describe('parseInterval', () => {
  it('parses the shapes CRMs and the API use', () => {
    expect(parseInterval('51-200')).toEqual({ min: 51, max: 200 });
    expect(parseInterval('1K-5K')).toEqual({ min: 1000, max: 5000 });
    expect(parseInterval('over 10K')).toEqual({ min: 10000, max: Infinity, minExclusive: true });
    expect(parseInterval('10,001+')).toEqual({ min: 10001, max: Infinity });
    expect(parseInterval('under $1M')).toEqual({ min: 0, max: 1_000_000, maxExclusive: true });
    expect(parseInterval('120 employees')).toEqual({ min: 120, max: 120 });
    expect(parseInterval('n/a')).toBeNull();
    expect(parseInterval('500-100')).toBeNull();
  });

  it('checks containment', () => {
    expect(isWithin({ min: 120, max: 120 }, { min: 51, max: 200 })).toBe(true);
    expect(isWithin({ min: 10001, max: Infinity }, { min: 10000, max: Infinity, minExclusive: true })).toBe(true);
    expect(isWithin({ min: 10000, max: 10000 }, { min: 10000, max: Infinity, minExclusive: true })).toBe(false);
    expect(isWithin({ min: 40, max: 120 }, { min: 51, max: 200 })).toBe(false);
  });
});

describe('countries', () => {
  it('resolves names, aliases and ISO codes to the same code', () => {
    for (const value of ['United States', 'USA', 'U.S.', 'US', 'united states of america']) {
      expect(countryCode(value)).toBe('US');
    }
    expect(countryCode('Deutschland')).toBe('DE');
    expect(countryCode('The Netherlands')).toBe('NL');
    expect(countryCode('Turkey')).toBe(countryCode('Türkiye'));
    expect(countryCode('Atlantis')).toBeNull();
  });

  it('compares a CRM country with the API country name', () => {
    expect(same('country', 'USA', 'United States')).toBe(true);
    expect(same('country', 'CA', 'Canada')).toBe(true);
    expect(same('country', 'AU', 'United States')).toBe(false);
    expect(normalizers.country.compare('Atlantis', 'United States').note).toContain('not a recognized country');
  });
});

describe('URLs and domains', () => {
  it('ignores protocol, www, trailing slashes and tracking parameters', () => {
    expect(canonicalUrl('https://www.linkedin.com/company/stripe/?trk=abc')).toBe('linkedin.com/company/stripe');
    expect(same('url', 'linkedin.com/company/shopify', 'https://www.linkedin.com/company/shopify/')).toBe(true);
    expect(same('url', 'http://linkedin.com/company/twilio', 'https://www.linkedin.com/company/twilio-inc-')).toBe(false);
  });

  it('normalizes domains from domain, website and email values', () => {
    expect(normalizeDomain('https://www.Atlassian.com/')).toBe('atlassian.com');
    expect(normalizeDomain('www.gitlab.com/company/')).toBe('gitlab.com');
    expect(normalizeDomain('jane@stripe.com')).toBe('stripe.com');
    expect(normalizeDomain('shop.example.co.uk:8080/x')).toBe('shop.example.co.uk');
    expect(normalizeDomain('not a domain')).toBeNull();
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('')).toBeNull();
    expect(same('domain', 'https://www.atlassian.com/', 'atlassian.com')).toBe(true);
  });
});

describe('text, names and years', () => {
  it('ignores legal suffixes in company names', () => {
    expect(same('companyName', 'HubSpot Inc.', 'HubSpot')).toBe(true);
    expect(same('companyName', 'Twilio, Inc', 'Twilio')).toBe(true);
    expect(same('companyName', 'Meta', 'Facebook')).toBe(false);
  });

  it('ignores case, accents and punctuation in text', () => {
    expect(same('text', 'Zürich', 'zurich')).toBe(true);
    expect(same('text', 'Media and Internet', 'Media & Internet')).toBe(true);
    expect(same('text', 'SF', 'San Francisco')).toBe(false);
  });

  it('reads years from spreadsheet formats', () => {
    expect(same('year', '2008.0', '2008')).toBe(true);
    expect(same('year', '2011-01-01', '2013')).toBe(false);
    expect(normalizers.year.compare('soon', '2013').note).toContain('not a year');
  });
});
