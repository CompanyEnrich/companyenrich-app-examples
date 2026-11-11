import { describe, expect, it } from 'vitest';
import { buildCompanyQuery, checkTechnologies, describeEnvironment, formatFilter } from '../src/lib/company-query.js';

const none = { technologies: [], employees: [] };

describe('buildCompanyQuery', () => {
  it('returns undefined when no environment is given', () => {
    expect(buildCompanyQuery(none)).toBeUndefined();
  });

  it('sends the description as a semantic query', () => {
    expect(buildCompanyQuery({ ...none, description: 'fintech companies' })).toEqual({ semantic: { query: 'fintech companies' } });
  });

  it('requires every technology with an `all` rule and adds size and country filters', () => {
    expect(buildCompanyQuery({ technologies: ['snowflake', 'looker'], employees: ['51-200', '201-500'], country: 'US' })).toEqual({
      filter: { technologies: { all: ['snowflake', 'looker'] }, employees: ['51-200', '201-500'], country: 'US' },
    });
  });

  it('combines a description with filters', () => {
    expect(buildCompanyQuery({ description: 'B2B SaaS', technologies: [], employees: ['1K-5K'] })).toEqual({
      semantic: { query: 'B2B SaaS' },
      filter: { employees: ['1K-5K'] },
    });
  });
});

describe('checkTechnologies', () => {
  it('keeps exact matches in the API spelling and reports unknown names with suggestions', () => {
    const suggestions = new Map([
      ['Snowflake', ['snowflake']],
      ['dbt', []],
      ['react', ['react native', 'react redux']],
    ]);
    expect(checkTechnologies(['Snowflake', 'dbt', 'react'], suggestions)).toEqual({
      known: ['snowflake'],
      unknown: [
        { name: 'dbt', suggestions: [] },
        { name: 'react', suggestions: ['react native', 'react redux'] },
      ],
    });
  });
});

describe('describeEnvironment', () => {
  it('summarises the environment in one line', () => {
    expect(describeEnvironment({ description: 'fintech', technologies: ['snowflake'], employees: ['201-500', '501-1K'], country: 'US' })).toBe(
      '"fintech" · HQ in US · 201-500 or 501-1K employees · uses snowflake',
    );
    expect(describeEnvironment(none)).toBe('any company');
  });
});

describe('formatFilter', () => {
  it('turns inferred filters into readable text', () => {
    expect(
      formatFilter({ country: { in: ['US'] }, employees: { in: ['51-200', '201-500'] }, technologies: { all: ['snowflake', 'looker'] }, domain: { notIn: ['x.com'] } }),
    ).toBe('country: US; employees: 51-200 or 201-500; technologies: snowflake and looker; domain: not x.com');
    expect(formatFilter({ country: 'US', employees: ['1-10', '11-50'], fundingAmount: { min: 1000000 } })).toBe(
      'country: US; employees: 1-10 or 11-50; fundingAmount: {"min":1000000}',
    );
  });
});
