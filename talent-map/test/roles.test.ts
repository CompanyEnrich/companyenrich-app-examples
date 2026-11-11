import { describe, expect, it } from 'vitest';
import { departmentFor, headcountKeys, personFilter, resolveRole } from '../src/lib/roles.js';

describe('departmentFor', () => {
  it('maps titles to the most specific department in the table', () => {
    expect(departmentFor('Senior Data Engineer')).toBe('engineering-technical/data-science');
    expect(departmentFor('Frontend Engineer')).toBe('engineering-technical/web-development');
    expect(departmentFor('Full Stack Developer')).toBe('engineering-technical/software-development');
    expect(departmentFor('UX Researcher')).toBe('design/product-ui-ux-design');
    expect(departmentFor('Enterprise Account Executive')).toBe('sales');
  });

  it('falls back to the root department for generic engineering titles', () => {
    expect(departmentFor('Mechanical Engineer')).toBe('engineering-technical');
  });

  it('matches whole words only', () => {
    expect(departmentFor('Luxury Retail Associate')).toBeUndefined(); // "ux" inside a word
    expect(departmentFor('Chief of Staff')).toBeUndefined();
  });
});

describe('resolveRole', () => {
  it('marks a phrase as known when autocomplete lists it exactly, ignoring case', () => {
    const role = resolveRole(['data engineer'], new Map([['data engineer', ['Data Engineer', 'Senior Data Engineer']]]));
    expect(role.checks[0]).toMatchObject({ phrase: 'data engineer', known: true, department: 'engineering-technical/data-science' });
    expect(role.titles).toEqual(['data engineer']);
    expect(role.departments).toEqual(['engineering-technical/data-science']);
  });

  it('uses the autocomplete suggestions when the phrase itself is not in the mapping', () => {
    const role = resolveRole(['staff platform'], new Map([['staff platform', ['Staff Platform Engineer']]]));
    expect(role.checks[0]).toMatchObject({ known: false, department: 'engineering-technical' });
  });

  it('leaves the department empty when nothing maps, and dedupes across phrases', () => {
    expect(resolveRole(['chief of staff'], new Map()).departments).toEqual([]);
    const both = resolveRole(['data engineer', 'analytics engineer'], new Map());
    expect(both.departments).toEqual(['engineering-technical/data-science']);
  });
});

describe('headcountKeys', () => {
  it('maps departments to the workforce keys of their roots, once each', () => {
    expect(headcountKeys(['engineering-technical/data-science', 'engineering-technical/devops'])).toEqual(['engineeringTechnical']);
    expect(headcountKeys(['c-suite/founder', 'human-resources'])).toEqual(['cSuite', 'humanResources']);
    expect(headcountKeys([])).toEqual([]);
  });
});

describe('personFilter', () => {
  const role = { titles: ['data engineer'], departments: ['engineering-technical/data-science' as const] };

  it('includes only the filters that are set', () => {
    expect(personFilter(role)).toEqual({ position: ['data engineer'], department: ['engineering-technical/data-science'] });
    expect(personFilter({ titles: ['x'], departments: [] }, { seniority: [] })).toEqual({ position: ['x'] });
  });

  it('adds seniority and the tenure cutoff', () => {
    expect(personFilter(role, { seniority: ['senior', 'director'], joinedBefore: '2024-11-11' })).toEqual({
      position: ['data engineer'],
      department: ['engineering-technical/data-science'],
      seniority: ['senior', 'director'],
      currentCompanyStartDate: { before: '2024-11-11' },
    });
  });
});
