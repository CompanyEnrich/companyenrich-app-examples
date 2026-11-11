import { describe, expect, it } from 'vitest';
import { normalizeDomain, readCustomerDomains } from '../src/lib/domains.js';

describe('normalizeDomain', () => {
  it.each([
    ['acme.com', 'acme.com'],
    ['  ACME.com ', 'acme.com'],
    ['https://www.acme.com/pricing?plan=pro#faq', 'acme.com'],
    ['http://app.acme.io:8080/login', 'app.acme.io'],
    ['www2.acme.co.uk', 'acme.co.uk'],
    ['jane.doe@acme.com', 'acme.com'],
    ['acme.com.', 'acme.com'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeDomain(raw)).toBe(expected);
  });

  it.each(['', 'n/a', 'localhost', 'acme', 'acme..com', '-acme.com', 'acme.c', 'acme com'])('rejects %j', (raw) => {
    expect(normalizeDomain(raw)).toBeUndefined();
  });
});

describe('readCustomerDomains', () => {
  it('uses the "domain" column wherever it is, and reports duplicates and invalid rows', () => {
    const csv = 'name,Domain,owner\nAcme,https://acme.com/,sam\n"Beta, Inc.",www.beta.io,kim\nAcme EU,ACME.COM,sam\nTest,n/a,sam\n,,\n';
    expect(readCustomerDomains(csv)).toEqual({
      domains: ['acme.com', 'beta.io'],
      invalid: [{ row: 5, value: 'n/a' }],
      duplicates: 1,
    });
  });

  it('falls back to the first column and keeps a domain on the first row', () => {
    expect(readCustomerDomains('acme.com\r\nbeta.io\r\n').domains).toEqual(['acme.com', 'beta.io']);
  });

  it('skips a header row when there is no "domain" column', () => {
    const result = readCustomerDomains('website,name\nacme.com,Acme\n');
    expect(result.domains).toEqual(['acme.com']);
    expect(result.invalid).toEqual([]);
  });
});
