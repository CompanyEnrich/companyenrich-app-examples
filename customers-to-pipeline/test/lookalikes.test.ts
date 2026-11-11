import { describe, expect, it } from 'vitest';
import { buildLookalikeQuery, customerDomains, selectSeeds, type Customer } from '../src/lib/lookalikes.js';
import { allocateContacts } from '../src/lib/people.js';
import { CUSTOMERS, INDUSTRY_CODES, makeCompany } from './fake-api.js';

const icp = { naicsCodes: ['5112', '5132', '334614'], employees: ['201-500' as const], country: ['US'] };

describe('selectSeeds', () => {
  it('picks the customers matching the most ICP dimensions, ties in CSV order', () => {
    const customers: Customer[] = CUSTOMERS.map((company) => ({ domain: company.domain, company }));
    // alpha..delta match all 3; echo..golf miss employees; hotel..juliet match fewer
    expect(selectSeeds(customers, icp, INDUSTRY_CODES, 5)).toEqual([
      'alpha.example',
      'bravo.example',
      'charlie.example',
      'delta.example',
      'echo.example',
    ]);
  });

  it('caps seeds at 10, the lookalike maximum', () => {
    const many: Customer[] = Array.from({ length: 14 }, (_, index) => ({ domain: `c${index}.example`, company: makeCompany(`c${index}.example`) }));
    expect(selectSeeds(many, icp, INDUSTRY_CODES)).toHaveLength(10);
  });

  it("sends each company's primary domain once, and uses CSV domains when nothing is enriched", () => {
    const aliases: Customer[] = [
      { domain: 'acme.io', company: makeCompany('acme.com') },
      { domain: 'acme.com', company: makeCompany('acme.com') },
      { domain: 'ghost.example' },
    ];
    expect(selectSeeds(aliases, icp, INDUSTRY_CODES)).toEqual(['acme.com']);
    expect(selectSeeds([{ domain: 'a.example' }, { domain: 'b.example' }], icp, INDUSTRY_CODES)).toEqual(['a.example', 'b.example']);
  });
});

describe('buildLookalikeQuery', () => {
  it('searches inside the ICP and excludes every customer domain with notIn', () => {
    const customers: Customer[] = [{ domain: 'acme.io', company: makeCompany('acme.com') }, { domain: 'beta.io' }];
    const query = buildLookalikeQuery(['acme.com'], { ...icp, domain: 'stale.example' }, customerDomains(customers));
    expect(query).toEqual({
      lookalike: { domains: ['acme.com'] },
      filter: { ...icp, domain: { notIn: ['acme.io', 'acme.com', 'beta.io'] } },
    });
  });
});

describe('allocateContacts', () => {
  it.each([
    [[5, 5, 5], 5, [2, 2, 1]],
    [[3, 0, 2], 4, [2, 0, 2]],
    [[1, 1], 5, [1, 1]],
    [[0, 0], 3, [0, 0]],
    [[4, 4, 4, 4, 4], 3, [1, 1, 1, 0, 0]],
  ])('available %j, wanted %i -> %j', (available, wanted, expected) => {
    expect(allocateContacts(available, wanted)).toEqual(expected);
  });
});
